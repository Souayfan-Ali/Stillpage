/**
 * The whole network build (filter-pipeline notes §2 stages 2–8, P1-32): compile the network rulesets, build the
 * pop-up artefacts, validate in Chromium, gate the bucket overhead, assign ledger ids, emit and gate
 * the budgets. Pure apart from the regex checker port; the CLI does every file read and write.
 */
import type { ListsConfig } from '../config/schema.js';
import { emitBuild, type EmitOutput } from '../emit/emit.js';
import { stemIndex } from '../entities/expand.js';
import { entityIndex, type Entities } from '../entities/schema.js';
import { buildPopups, uncoveredDestinations, type PopupBuild } from '../popups/emit.js';
import { liftedDestinations } from '../popups/lift.js';
import { assertBucketOverhead } from '../postpass/buckets.js';
import { assertBudgets, growthReport, slotsOf, type CountsFile, type Growth, type Slot } from '../postpass/budgets.js';
import type { BucketedRule } from '../postpass/coalesce.js';
import { assignIds, emptyLedger, type Ledger } from '../postpass/ledger.js';
import { resolveRegexes, type RegexCache, type RegexChecker } from '../validate/regex.js';
import { validateRules } from '../validate/validate.js';
import { buildContent, type ContentBuild, type ScriptletPort } from '../content/build.js';
import type { UboParser } from '../vendor/ubo.js';
import type { Entry } from '../parse/parse-list.js';
import { deadBadfilters } from '../overrides/overrides.js';
import { compileNetwork, parseAll, type NetworkRuleset } from './network.js';
import { buildReport, type BuildReport } from './report.js';
import { regexQueries, validateNetwork } from './validate-network.js';

export interface BuildInputs {
  readonly config: ListsConfig;
  /** List id → text (checked against the lock by the caller). */
  readonly texts: ReadonlyMap<string, string>;
  readonly entities: Entities;
  /** Slot id → ledger; a missing slot starts empty. */
  readonly ledgers: ReadonlyMap<string, Ledger>;
  readonly regexCache: RegexCache;
  readonly previousCounts?: CountsFile;
  /** Cosmetic and scriptlet emitters (P1-27…P1-29); without it the build emits no content. */
  readonly content?: ContentInputs;
  /** uBO's redirect resources (P1-30); without them the converter's resource paths are kept. */
  readonly surrogates?: SurrogateInputs;
  /** Checked override entries by ruleset id (P2-08), applied before conversion. */
  readonly overrides?: ReadonlyMap<string, readonly Entry[]>;
  /** Declared slots expected (36; 32 after `--drop-pending`, P2-29). */
  readonly expectedSlots?: number;
}

export interface SurrogateInputs {
  /** Resource name or alias → file name. */
  readonly index: ReadonlyMap<string, string>;
  /** File name → bytes (hash-checked vendor copy). */
  readonly bytes: ReadonlyMap<string, Uint8Array>;
}

export interface ContentInputs {
  readonly ubo: UboParser;
  /** uBO's procedural engine file, vendored verbatim (P1-28). */
  readonly engine: string;
  readonly scriptlets?: ScriptletPort;
}

export interface BuildResult {
  readonly emit: EmitOutput;
  readonly ledgers: ReadonlyMap<string, Ledger>;
  readonly regexCache: RegexCache;
  /** Query key → supported, for every regex of this build (the verify stage's result file). */
  readonly regexResults: Readonly<Record<string, boolean>>;
  readonly growth: readonly Growth[];
  readonly report: BuildReport;
  readonly content?: ContentBuild;
  /** Override `$badfilter` entries that cancel nothing upstream (P2-08): warnings, never failures. */
  readonly deadOverrides: readonly string[];
}

/** Hosts some rule of the build names, for observed entity expansion (D-20). */
const namedHosts = (rulesets: readonly NetworkRuleset[]): readonly string[] =>
  rulesets.flatMap((r) => [...r.safe, ...r.unsafe]).flatMap((r) => [...(r.rule.condition.requestDomains ?? []), ...(r.rule.condition.initiatorDomains ?? [])]);

/** Hosts named by cosmetic and scriptlet filters (entity forms excluded), for observed expansion. */
const contentHosts = (rulesets: readonly NetworkRuleset[]): readonly string[] =>
  rulesets.flatMap((r) => r.rest).flatMap((e) => (e.node?.category === 'Cosmetic' ? e.node.domains.children.map((d) => d.value) : []))
    .filter((d) => !d.endsWith('.*'));

function runContent(compiled: readonly NetworkRuleset[], inputs: ContentInputs): ContentBuild {
  const stems = stemIndex([...namedHosts(compiled), ...contentHosts(compiled)]);
  return buildContent(compiled.map((r) => ({ config: r.config, entries: r.rest })), inputs.ubo, { stems }, inputs.scriptlets);
}

/** Slot id → its rules before ids; fails when rules have no slot to go to. */
function rulesBySlot(slots: readonly Slot[], network: readonly NetworkRuleset[], popups: { readonly id: string; readonly rules: readonly BucketedRule[] }): ReadonlyMap<string, readonly BucketedRule[]> {
  const ids = new Set(slots.map((s) => s.id));
  const pairs: [string, readonly BucketedRule[]][] = network.flatMap((r) => [[r.config.id, r.safe], [`${r.config.id}-x`, r.unsafe]] as [string, readonly BucketedRule[]][]);
  const bad = pairs.find(([id, rules]) => rules.length > 0 && !ids.has(id));
  if (bad) throw new Error(`${String(bad[1].length)} rules for "${bad[0]}", which is not a declared slot`);
  return new Map([...pairs.filter(([id]) => ids.has(id)), [popups.id, popups.rules]]);
}

function withIds(slots: readonly Slot[], bySlot: ReadonlyMap<string, readonly BucketedRule[]>, ledgers: ReadonlyMap<string, Ledger>) {
  const rules = new Map<string, readonly BucketedRule[]>();
  const next = new Map<string, Ledger>();
  for (const s of slots) {
    const assigned = assignIds(s.id, bySlot.get(s.id) ?? [], ledgers.get(s.id) ?? emptyLedger(s.id));
    rules.set(s.id, assigned.rules);
    next.set(s.id, assigned.ledger);
  }
  return { rules, ledgers: next };
}

function checkPopups(popups: PopupBuild, kept: readonly BucketedRule[]): void {
  if (kept.length !== popups.rules.length) throw new Error(`validation dropped ${String(popups.rules.length - kept.length)} popups rules`);
  const missing = uncoveredDestinations(popups.destinations, kept);
  if (missing.length > 0) throw new Error(`popup-destinations.json has hosts no popups block covers: ${missing.slice(0, 5).join(', ')}`);
}

/** Packs enabled when the user has made no choice. */
export const defaultPacksOf = (config: ListsConfig): ReadonlySet<string> =>
  new Set(Object.entries(config.packs).filter(([, p]) => p.default).map(([id]) => id));

/** Runs the build. Throws on any gate failure (budgets, overhead, invariants, unknown reasons). */
export async function runBuild(inputs: BuildInputs, checker: RegexChecker): Promise<BuildResult> {
  const { config } = inputs;
  const entityOf = entityIndex(inputs.entities);
  const parsed = parseAll(config, inputs.texts);
  const overrides = inputs.overrides ?? new Map<string, readonly Entry[]>();
  const compiled = await compileNetwork(config, parsed, entityOf, inputs.surrogates?.index, overrides);
  const popupEntries = compiled.filter((r) => config.popups.from.includes(r.config.id)).flatMap((r) => r.popupEntries);
  const popups = buildPopups(popupEntries, stemIndex(namedHosts(compiled)), entityOf);
  const queries = [...regexQueries(compiled), ...regexQueries([{ safe: popups.rules, unsafe: [] }])];
  const resolved = await resolveRegexes(queries, inputs.regexCache, checker);
  const network = validateNetwork(compiled, resolved.answers);
  const popupKept = validateRules(popups.rules, resolved.answers).kept;
  checkPopups(popups, popupKept);
  const overhead = assertBucketOverhead([...compiled.map((r) => ({ rules: [...r.safe, ...r.unsafe], maximal: r.maximal })),
    { rules: popups.rules, maximal: popups.maximal }]);
  const slots = slotsOf(config);
  const ids = withIds(slots, rulesBySlot(slots, network, { id: config.popups.id, rules: popupKept }), inputs.ledgers);
  const content = inputs.content === undefined ? undefined : runContent(compiled, inputs.content);
  // D-55 / D-55a: from the rules exactly as they ship (validated, with ids), full release only.
  const lift = liftedDestinations(popups.destinations, new Map([...ids.rules].map(([id, rules]) => [id, rules.map((r) => r.rule)])));
  const emit = emitBuild({ config, slots, rules: ids.rules, entities: inputs.entities, destinations: popups.destinations, lifted: lift.lifted,
    strictSites: popups.strictSites, log: [...network.flatMap((r) => r.log), ...popups.log, ...(content?.log ?? [])],
    ...(content && inputs.content && { content: { build: content, engine: inputs.content.engine } }),
    ...(inputs.surrogates && { surrogates: inputs.surrogates.bytes }) });
  assertBudgets(slots, emit.counts, inputs.expectedSlots);
  const regexResults = Object.fromEntries([...resolved.answers].map(([k, a]) => [k, a.isSupported]));
  const report = buildReport({ slots, counts: emit.counts, network, popups, lift: lift.summary, overhead, ledgers: ids.ledgers, regexAsked: resolved.asked, regexTotal: resolved.answers.size, content, defaultPacks: defaultPacksOf(config) });
  return { emit, ledgers: ids.ledgers, regexCache: resolved.cache, regexResults, growth: growthReport(inputs.previousCounts, emit.counts), report,
    deadOverrides: deadBadfilters(overrides, [...parsed.values()].flat()), ...(content && { content }) };
}
