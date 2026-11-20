/**
 * `npm run lists:build [-- --ledger-dir <dir>] [-- --fail-on-growth] [-- --no-chromium-load] [-- --check-determinism]
 *   [-- --channel dev|public] [-- --drop-pending]`
 *
 * `--channel public` fails while an owner-pending pack is shipped (D-16); `--drop-pending` removes those
 * packs, their rulesets and lists before the compile (36 → 32 slots): the store-ready build (P2-29).
 *
 * Offline build from the lock and the cache (run `lists:fetch` first): compile → validate in Chromium →
 * ledger ids → emit `public/` (shipped) and `dist/compiler/` (id maps, log, report, manifest fragment,
 * regex results) → verify (artefact checks, count oracle, snapshot, unpacked load in Chromium).
 * Exit codes: 1 build or verify failure, 3 growth over 10 % with `--fail-on-growth` (open a PR), 4 count-oracle
 * failure only (open or update the oracle PR for a human, D-40); nothing is written to `public/` on 1 or 4.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DISPATCH_BUDGET, GLOBAL_STATIC_RULE_POOL, GUARANTEED_STATIC_RULES, RULESET_SLOTS, SCRIPTLET_CODE_BUDGET, SCRIPTLET_CODE_PACK_GZIP } from '../../src/core/limits.js';
import { oversizedPackCode, scriptletSizes } from '../content/sizes.js';
import { chromiumRegexChecker, loadRulesets } from '../chromium/node-ports.js';
import { channelProblems, withoutPendingPacks, type Channel } from '../config/channel.js';
import { loadListsConfig, loadLock, parseJsonWith } from '../config/load.js';
import { EntitiesSchema } from '../entities/schema.js';
import { loadLockedLists } from '../fetch/fetch.js';
import { nodePorts } from '../fetch/node-ports.js';
import { OracleFileSchema, countOracle } from '../oracle/count.js';
import { serialiseCounts, slotsOf, withCarriedCounts } from '../postpass/budgets.js';
import { rulesetPath } from '../emit/emit.js';
import { snapshotDiff } from '../verify/snapshot.js';
import { verifyArtefacts } from '../verify/verify.js';
import { verifyContent } from '../verify/content.js';
import { fixedReserve } from '../verify/patterns.js';
import { loadVendorLock, vendorReader } from '../vendor/node-ports.js';
import { loadUboParser } from '../vendor/ubo.js';
import { loadLibrary, scriptletPort } from '../scriptlets/port.js';
import { readCounts, readLedgers, readPreviousRulesets, readRegexCache, replaceTree, writeLedgers, writeText, writeTree } from './node-ports.js';
import { readRedirectResources } from '../vendor/resources.js';
import { resourceIndex } from '../surrogates/redirects.js';
import { redirectProblems } from '../surrogates/files.js';
import { checkOverrides, overrideEntries, parseOverrides } from '../overrides/overrides.js';
import type { ListsConfig } from '../config/schema.js';
import type { Entry } from '../parse/parse-list.js';
import { buildVerdict, EXIT, ORACLE_FAILURE_PREFIX } from './verdict.js';
import { defaultPacksOf, runBuild, type BuildInputs, type BuildResult, type ContentInputs, type SurrogateInputs } from './pipeline.js';
import { errorText } from '../cli/errors.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const P = {
  config: path.join(ROOT, 'lists/lists.config.json'), lock: path.join(ROOT, 'lists/lists.lock.json'), entities: path.join(ROOT, 'lists/entities.json'),
  counts: path.join(ROOT, 'lists/ruleset-counts.json'), overrides: path.join(ROOT, 'lists/overrides/overrides.json'), cache: path.join(ROOT, '.cache/lists'), snapshots: path.join(ROOT, 'lists/snapshots'), regexCache: path.join(ROOT, '.cache/regex/cache.json'),
  out: path.join(ROOT, 'public'), debug: path.join(ROOT, 'dist/compiler'),
};
const GUARANTEED_PLUS_POOL = GUARANTEED_STATIC_RULES + GLOBAL_STATIC_RULE_POOL;
const say = (line: string): void => { process.stdout.write(`${line}\n`); };
const NEAR = 0.95;
/** Directories under `public/` that only the compiler writes (git-ignored, tooling notes §3). */
const GENERATED_DIRS = ['cosmetic', 'scriptlets', 'surrogates'];
const ENGINE_FILE = 'platform/mv3/extension/js/scripting/css-procedural-api.js';

const WAR_DIR = 'src/web_accessible_resources/';

/** uBO's redirect resources (names, aliases, bytes) from the hash-checked vendor copy (P1-30). */
async function surrogateInputs(): Promise<SurrogateInputs> {
  const lock = await loadVendorLock();
  const read = vendorReader(lock);
  const resources = readRedirectResources((await read('src/js/redirect-resources.js')).toString('utf8'))
    .filter((r) => Object.hasOwn(lock.files, `${WAR_DIR}${r.name}`));
  const bytes = new Map(await Promise.all(resources.map(async (r) => [r.name, new Uint8Array(await read(`${WAR_DIR}${r.name}`))] as const)));
  return { index: resourceIndex(resources), bytes };
}

async function contentInputs(): Promise<ContentInputs> {
  const lock = await loadVendorLock();
  const engine = (await vendorReader(lock)(ENGINE_FILE)).toString('utf8');
  const ubo = await loadUboParser(lock);
  return { ubo, engine, scriptlets: scriptletPort(await loadLibrary(lock), ubo, lock.commit) };
}

/** Checked overrides (P2-08): an expired or invalid entry fails the build; warnings are printed. */
async function overrides(config: ListsConfig): Promise<ReadonlyMap<string, readonly Entry[]>> {
  const file = parseOverrides(await readFile(P.overrides, 'utf8'), P.overrides);
  const check = checkOverrides(file, { today: new Date().toISOString().slice(0, 10), rulesets: new Set(config.rulesets.map((r) => r.id)) });
  for (const w of check.warnings) say(`warning: override ${w}`);
  if (check.errors.length > 0) throw new Error(`overrides:\n  ${check.errors.join('\n  ')}`);
  return overrideEntries(file);
}

interface ChannelOptions {
  readonly channel: Channel;
  readonly dropPending: boolean;
}

/**
 * The config for this channel and the ids of the slots `--drop-pending` left out; throws when a public build
 * would ship an owner-pending pack.
 */
async function channelConfig(o: ChannelOptions): Promise<{ readonly config: ListsConfig; readonly expectedSlots: number; readonly dropped: readonly string[] }> {
  const full = await loadListsConfig(P.config);
  const config = o.dropPending ? withoutPendingPacks(full) : full;
  const problems = channelProblems(config, o.channel);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const built = new Set(slotsOf(config).map((s) => s.id));
  const dropped = slotsOf(full).map((s) => s.id).filter((id) => !built.has(id));
  return { config, expectedSlots: RULESET_SLOTS - dropped.length, dropped };
}

async function inputs(ledgerDir: string, o: ChannelOptions): Promise<{ readonly input: BuildInputs; readonly dropped: readonly string[] }> {
  const { config, expectedSlots, dropped } = await channelConfig(o);
  const texts = await loadLockedLists(config, await loadLock(P.lock), nodePorts(P.cache, [P.snapshots]).readCache);
  const entities = parseJsonWith(EntitiesSchema, await readFile(P.entities, 'utf8'), P.entities);
  const ledgers = await readLedgers(ledgerDir, slotsOf(config).map((s) => s.id));
  const previousCounts = await readCounts(P.counts);
  const regexCache = await readRegexCache(P.regexCache, chromiumRegexChecker().id);
  return { dropped, input: { config, texts, entities, ledgers, regexCache, content: await contentInputs(), surrogates: await surrogateInputs(),
    overrides: await overrides(config), expectedSlots, ...(previousCounts && { previousCounts }) } };
}

async function verify(build: BuildResult, input: BuildInputs, load: boolean): Promise<string[]> {
  const slots = slotsOf(input.config);
  const v = verifyArtefacts({ slots, popupsId: input.config.popups.id, files: build.emit.shipped, ledgers: build.ledgers, regexResults: build.regexResults });
  const unsafe = slots.filter((s) => s.unsafe).flatMap((s) => v.rules.get(s.id) ?? []);
  const failures = [...v.failures, ...contentFailures(build, input), ...(input.surrogates ? redirectProblems(unsafe, build.emit.binary) : [])];
  const oracle = OracleFileSchema.parse(JSON.parse(await readFile(path.join(ROOT, input.config.oracle.file), 'utf8')));
  const pairs = new Map(Object.keys(oracle.rulesets).map((id) => [id, [...(v.rules.get(id) ?? []), ...(v.rules.get(`${id}-x`) ?? [])]]));
  const rows = countOracle(oracle, pairs, new Map(Object.entries(build.report.popups.bySource)), input.config.oracle);
  for (const r of rows) say(`oracle ${r.verdict.padEnd(4)} ${r.what}: ours ${String(r.ours)} vs uBOL ${String(r.theirs)} (${(r.change * 100).toFixed(1)} %)`);
  failures.push(...rows.filter((r) => r.verdict === 'fail').map((r) => `${ORACLE_FAILURE_PREFIX}${r.what}`));
  if (build.report.extraRejections.share > build.report.extraRejections.max) failures.push(`extra rejections ${(build.report.extraRejections.share * 100).toFixed(3)} % > 1 %`);
  if (load) {
    const files = slots.map((s) => ({ id: s.id, rules: v.rules.get(s.id) ?? [] }));
    const total = files.reduce((n, f) => n + f.rules.length, 0);
    const loaded = await loadRulesets(files);
    const consumed = GUARANTEED_PLUS_POOL - loaded.available;
    say(`chromium load: ${String(loaded.enabled.length)} / ${String(files.length)} rulesets enabled, ${String(consumed)} / ${String(total)} rules indexed`);
    if (loaded.enabled.length !== files.length || consumed !== total) failures.push('unpacked load: not every ruleset or rule was enabled');
  }
  return failures;
}

function contentFailures(build: BuildResult, input: BuildInputs): string[] {
  if (build.content === undefined) return [];
  const lost = build.content.stats.lostEntities.length;
  const max = input.config.content.maxLostEntities;
  const defaults = defaultPacksOf(input.config);
  const listPack = new Map(input.config.rulesets.flatMap((r) => r.lists.map((l) => [l, r.pack] as const)));
  const unknown = [...build.content.log, ...build.report.redirects.unknown].filter((l) => (l.reason === 'scriptlet-unknown' || l.reason === 'redirect-unknown') && defaults.has(listPack.get(l.source.list) ?? ''));
  const regionalPacks = new Set(input.config.rulesets.filter((r) => r.category === 'regional').map((r) => r.pack));
  return [...verifyContent({ files: build.emit.shipped, registrations: build.content.registrations, defaultPacks: defaults, regionalPacks,
    fixed: fixedReserve((JSON.parse(build.emit.shipped.get('popup-strict-sites.json') ?? '[]') as unknown[]).length) }),
    ...sizeFailures(build.emit.shipped, [...defaults], [...new Set(input.config.rulesets.map((r) => r.pack))]),
    ...(unknown.length > 0 ? [`${String(unknown.length)} unknown scriptlet or redirect name(s) in default lists (e.g. ${unknown[0]?.detail ?? ''})`] : []),
    ...(lost > max ? [`${String(lost)} entity names lost by observed expansion > ${String(max)} (D-20)`] : [])];
}

/** D-22 budgets over the default packs, the per-pack code gate over every pack; prints the figures and warns at 95 %. */
function sizeFailures(files: ReadonlyMap<string, string>, packs: readonly string[], allPacks: readonly string[]): string[] {
  const s = scriptletSizes(files, packs);
  say(`scriptlets: dispatch ${String(s.dispatch.raw)} / ${String(DISPATCH_BUDGET.raw)} B raw, ${String(s.dispatch.gzip)} / ${String(DISPATCH_BUDGET.gzip)} B gzip; code ${String(s.code.raw)} / ${String(SCRIPTLET_CODE_BUDGET.raw)} raw, ${String(s.code.gzip)} / ${String(SCRIPTLET_CODE_BUDGET.gzip)} gzip`);
  const near = s.dispatch.raw > DISPATCH_BUDGET.raw * NEAR || s.dispatch.gzip > DISPATCH_BUDGET.gzip * NEAR;
  if (near) say('warning: scriptlet dispatch over 95 % of its budget (D-22: next lever is grouping hosts by identical index tuple)');
  return [
    ...(s.dispatch.raw > DISPATCH_BUDGET.raw || s.dispatch.gzip > DISPATCH_BUDGET.gzip ? ['scriptlet dispatch data over the D-22 budget'] : []),
    ...(s.code.raw > SCRIPTLET_CODE_BUDGET.raw || s.code.gzip > SCRIPTLET_CODE_BUDGET.gzip ? ['scriptlet code over the D-22 budget'] : []),
    ...oversizedPackCode(files, allPacks, SCRIPTLET_CODE_PACK_GZIP),
  ];
}

/** Same bytes, text or binary. */
const sameBytes = (a: string | Uint8Array | undefined, b: string | Uint8Array): boolean =>
  typeof b === 'string' ? a === b : a instanceof Uint8Array && Buffer.from(a).equals(b);

/**
 * A second build from the same inputs, compared tree by tree: `shipped`, `debug` and (since P2-48, D-34)
 * the binary surrogates. Trees are compared separately because both `shipped` and `debug` hold a
 * `registrations.json` (the shipped one and a pretty debug copy); one merged lookup compared them crosswise.
 */
async function determinism(input: BuildInputs, first: BuildResult): Promise<string[]> {
  const again = await runBuild({ ...input, regexCache: first.regexCache }, chromiumRegexChecker());
  const trees = [['shipped', first.emit.shipped, again.emit.shipped], ['debug', first.emit.debug, again.emit.debug], ['binary', first.emit.binary, again.emit.binary]] as const;
  const differ = trees.flatMap(([name, a, b]: readonly [string, ReadonlyMap<string, string | Uint8Array>, ReadonlyMap<string, string | Uint8Array>]) => [
    ...[...a].filter(([k, t]) => !sameBytes(b.get(k), t)).map(([k]) => `${name}/${k}`),
    ...[...b.keys()].filter((k) => !a.has(k)).map((k) => `${name}/${k}`),
  ]);
  return differ.length === 0 ? [] : [`not deterministic: ${differ.slice(0, 5).join(', ')}`];
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'ledger-dir': { type: 'string', default: path.join(ROOT, 'lists/ledger') }, 'fail-on-growth': { type: 'boolean', default: false },
    'no-chromium-load': { type: 'boolean', default: false }, 'check-determinism': { type: 'boolean', default: false },
    channel: { type: 'string', default: 'dev' }, 'drop-pending': { type: 'boolean', default: false } } });
  if (values.channel !== 'dev' && values.channel !== 'public') throw new Error(`--channel expects dev or public, got "${values.channel}"`);
  const t0 = performance.now();
  const { input, dropped } = await inputs(values['ledger-dir'], { channel: values.channel, dropPending: values['drop-pending'] });
  const before = await readPreviousRulesets(path.join(P.out, 'rulesets'));
  const build = await runBuild(input, chromiumRegexChecker());
  const failures = [...await verify(build, input, !values['no-chromium-load']), ...(values['check-determinism'] ? await determinism(input, build) : [])];
  await writeTree(P.debug, new Map([...build.emit.debug, ['report.json', `${JSON.stringify(build.report, null, 1)}\n`],
    ['regex-results.json', `${JSON.stringify({ chromium: build.regexCache.chromium, results: build.regexResults }, null, 1)}\n`],
    ['snapshot.json', `${JSON.stringify(snapshotDiff(before, new Map(slotsOf(input.config).map((s) => [s.id, build.emit.shipped.get(rulesetPath(s.id)) ?? '[]']))), null, 1)}\n`]]));
  await writeText(P.regexCache, `${JSON.stringify(build.regexCache)}\n`);
  // A failed build leaves `public/` (what WXT packages) as it was; the debug tree explains the failure.
  const verdict = buildVerdict(failures, { growth: build.growth.length > 0, failOnGrowth: values['fail-on-growth'] });
  if (verdict.exit === EXIT.oracle) {
    process.stderr.write(`lists:build: count oracle failed (exit 4: open or update the oracle PR, D-40):\n  ${failures.join('\n  ')}\n`);
    process.exitCode = EXIT.oracle;
    return;
  }
  if (!verdict.writeOutputs) throw new Error(`verify failed:\n  ${failures.join('\n  ')}`);
  // Generated content trees are replaced, never merged: a shard that no longer exists must not ship.
  // Staged beside `public/` and moved in by rename, so a failed write leaves the old tree whole (P2-48).
  await replaceTree(P.out, new Map<string, string | Uint8Array>([...build.emit.shipped, ...build.emit.binary]), GENERATED_DIRS);
  await writeLedgers(values['ledger-dir'], build.ledgers);
  // D-125: slots that `--drop-pending` did not build keep their previous figures (the growth baseline).
  await writeText(P.counts, serialiseCounts(withCarriedCounts(build.emit.counts, input.previousCounts, dropped)));
  const c = build.report.content;
  say(`content: ${String(c.patterns.default)} / ${String(c.patterns.max)} patterns (all packs ${String(c.patterns.all)}), ${String(c.registrations.all)} registrations, worst shard ${String(c.worstShardBytes ?? 0)} B, script bytes ${String(c.scriptBytes?.summed ?? 0)} summed / ${String(c.scriptBytes?.unique ?? 0)} unique, lost entities ${String(c.lostEntities?.length ?? 0)}, fail-open exceptions ${String(c.failOpenExceptions ?? 0)}`);
  const l = build.report.popups.lift;
  say(`pop-up lift (D-55a): ${String(l.lifted)} of ${String(l.candidates)} candidates lifted (${Object.entries(l.byRuleset).map(([id, n]) => `${id} ${String(n)}`).join(', ')}); excluded: malware ${String(l.excluded.malware)}, allow ${String(l.excluded.allow)}`);
  const t = build.report.totals.default;
  say(`default: ${String(t.rules)} / ${String(t.maxRules)} rules, ${String(t.regex)} / ${String(t.maxRegex)} regex; bucket overhead ${String(build.report.bucketOverhead)}; ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  for (const g of build.growth) say(`growth: ${g.slot} ${String(g.before)} → ${String(g.after)}`);
  for (const d of build.deadOverrides) say(`warning: ${d}`);
  if (verdict.exit !== EXIT.ok) process.exitCode = verdict.exit;
}

main().catch((e: unknown) => {
  process.stderr.write(`lists:build failed: ${errorText(e)}\n`);
  process.exitCode = 1;
});
