/**
 * Facts of one pack → inline shard data files and their registrations (P1-27 format, ADR-010 as
 * amended). Per world, a host is listed in exactly one registration of the pack (layout rule), and
 * only when no parent host of the same pack and world is listed (its `*://*.parent/*` pattern
 * already matches). Hosts with the same last two labels always share a registration, so parent and
 * child never sit in two registrations. Sites are packed into balanced shards (D-41). ISOLATED sites that need
 * code (procedural engine, ISOLATED scriptlets) are sharded apart from plain ones, so the code files are
 * repeated only in the few code-lane registrations: Chrome stores each registration's script text separately
 * in shared memory mapped into the browser and every renderer (P2-47).
 */
import type { CatalogRegistration, ScriptWorld } from '../../src/core/catalog/registrations.js';
import { commonDataPath, isolatedDataPath, mainDataPath, PROCEDURAL_ENGINE, RUNTIME_SCRIPTS, scriptletCodePath } from '../../src/core/content/files.js';
import { SHARD_DATA_VERSION, shardFileWrap, type CommonData, type HostEntry, type Invocation, type ShardData } from '../../src/core/content/shard-data.js';
import { MAX_SHARD_BYTES, SHARD_COUNT, SHARD_TARGET_MEAN_BYTES, SHARD_TARGET_WORST_BYTES } from '../../src/core/limits.js';
import { parentDomains } from '../../src/core/hostname/walk.js';
import type { Hostname } from '../../src/core/ids.js';
import type { Fact, FactKind } from './facts.js';

export interface PackInput {
  readonly pack: string;
  readonly isolated: readonly Fact[];
  readonly main: readonly Fact[];
  /** Index of a scriptlet in the pack's code file of `world` (`j`/`n` values are `JSON [name, ...args]`). */
  readonly fnIndex: (world: ScriptWorld, name: string) => number;
  /** Shard cap per world; `SHARD_COUNT` when absent (regional packs: `REGIONAL_SHARD_COUNT`, P2-32). */
  readonly maxShards?: number;
}

export interface PackContent {
  /** Packaged path → file text. */
  readonly files: ReadonlyMap<string, string>;
  readonly registrations: readonly CatalogRegistration[];
  readonly patterns: number;
  /** Largest data file, bytes. */
  readonly worstShardBytes: number;
}

const POSITIVE: Readonly<Record<ScriptWorld, ReadonlySet<FactKind>>> = { ISOLATED: new Set(['h', 's', 'p', 'j']), MAIN: new Set(['j']) };
const TABLE_OF = { h: 'selectors', u: 'selectors', s: 'styles', p: 'procedural', j: 'invocations', n: 'invocations' } as const;
type Table = (typeof TABLE_OF)[FactKind];

const tail = (host: string): string => host.split('.').slice(-2).join('.');
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Rough bytes a fact adds to its shard (table value + host entry); only used to balance shards. */
const weightOf = (f: Fact): number => f.value.length + f.host.length;

/**
 * Sites (hosts with the same last two labels) packed into `count` balanced shards numbered from `offset`
 * (D-41): heaviest site first into the lightest shard, ties by name, so the worst shard is close to the
 * mean and the layout is deterministic. A site never spans two shards (parent and child stay together).
 */
function groupByShard(facts: readonly Fact[], count: number, offset: number): ReadonlyMap<number, readonly Fact[]> {
  const bySite = new Map<string, Fact[]>();
  for (const f of facts) {
    const list = bySite.get(tail(f.host));
    if (list) list.push(f);
    else bySite.set(tail(f.host), [f]);
  }
  const sites = [...bySite].map(([site, list]) => ({ site, list, weight: list.reduce((n, f) => n + weightOf(f), 0) }))
    .sort((a, b) => b.weight - a.weight || byString(a.site, b.site));
  const loads = Array.from({ length: count }, () => 0);
  const out = new Map<number, Fact[]>();
  for (const s of sites) {
    const bin = loads.indexOf(Math.min(...loads));
    loads[bin] = (loads[bin] ?? 0) + s.weight;
    const list = out.get(offset + bin);
    if (list) list.push(...s.list);
    else out.set(offset + bin, [...s.list]);
  }
  return out;
}

function tables(facts: readonly Fact[], common: ReadonlyMap<string, number>): Readonly<Record<Table, readonly string[]>> {
  const of = (t: Table): string[] => [...new Set(facts.filter((f) => TABLE_OF[f.kind] === t && !(t === 'invocations' && common.has(f.value))).map((f) => f.value))].sort(byString);
  return { selectors: of('selectors'), styles: of('styles'), procedural: of('procedural'), invocations: of('invocations') };
}

function entryOf(facts: readonly Fact[], index: Readonly<Record<Table, ReadonlyMap<string, number>>>): HostEntry {
  const at = (kind: FactKind, value: string): number => {
    const i = index[TABLE_OF[kind]].get(value);
    if (i === undefined) throw new Error(`shard table has no entry for a ${kind} fact (${value.slice(0, 60)})`);
    return i;
  };
  const field = (kind: FactKind): number[] => [...new Set(facts.filter((f) => f.kind === kind).map((f) => at(kind, f.value)))].sort((a, b) => a - b);
  const fields = (['h', 'u', 's', 'p', 'j', 'n'] as const).map((k) => [k, field(k)] as const);
  const entry: HostEntry = Object.fromEntries(fields.filter(([, v]) => v.length > 0));
  return entry;
}

const invocationOf = (fnIndex: (name: string) => number) => (v: string): Invocation => {
  const [name = '', ...args] = JSON.parse(v) as string[];
  return [fnIndex(name), ...args];
};

/**
 * The data value of one shard (deterministic: sorted tables and hosts). Invocations in `common` are
 * referenced as `~i` (negative) into the pack's common table instead of being copied.
 */
function shardData(pack: string, shard: number, facts: readonly Fact[], fnIndex: (name: string) => number, common: ReadonlyMap<string, number>): ShardData {
  const t = tables(facts, common);
  const index = Object.fromEntries(Object.entries(t).map(([k, values]) => [k, new Map(values.map((v, i) => [v, i]))])) as Record<Table, Map<string, number>>;
  index.invocations = new Map([...index.invocations, ...[...common].map(([v, i]) => [v, ~i] as const)]);
  const byHost = new Map<string, Fact[]>();
  for (const f of facts) {
    const list = byHost.get(f.host);
    if (list) list.push(f);
    else byHost.set(f.host, [f]);
  }
  const hosts = [...byHost.keys()].sort(byString) as Hostname[];
  const invocation = invocationOf(fnIndex);
  return {
    v: SHARD_DATA_VERSION, pack, shard, hosts,
    entries: hosts.map((h) => entryOf(byHost.get(h) ?? [], index)),
    selectors: t.selectors,
    styles: t.styles.map((s) => JSON.parse(s) as [string, string]),
    procedural: t.procedural,
    invocations: t.invocations.map(invocation),
  };
}

/** Listed hosts: positive in this world and not under another positive host. */
function listedHosts(facts: readonly Fact[], world: ScriptWorld): readonly Hostname[] {
  const positive = new Set(facts.filter((f) => POSITIVE[world].has(f.kind)).map((f) => f.host));
  return [...positive].filter((h) => !parentDomains(h).slice(1).some((p) => positive.has(p))).sort(byString);
}

function registrationsOf(pack: string, shard: number, world: ScriptWorld, facts: readonly Fact[], common: ReadonlyMap<string, number>): CatalogRegistration[] {
  const listed = listedHosts(facts, world);
  if (listed.length === 0) return [];
  const usesCommon = facts.some((f) => (f.kind === 'j' || f.kind === 'n') && common.has(f.value));
  const commonFile = usesCommon ? [commonDataPath(pack, world)] : [];
  if (world === 'MAIN') return [{ id: `main:${pack}:${String(shard)}`, world, js: [...commonFile, mainDataPath(pack, shard), scriptletCodePath(pack, 'MAIN')], hosts: listed }];
  // At most two code sets per shard (D-41): "plain" (data + applier) and "full" (with the procedural engine and
  // the ISOLATED scriptlet code), so the shared code is not repeated in four variants of every shard.
  const needsCode = new Set(facts.filter((f) => f.kind === 'p' || f.kind === 'j').map((f) => tail(f.host)));
  const full = listed.filter((h) => needsCode.has(tail(h)));
  const plain = listed.filter((h) => !needsCode.has(tail(h)));
  const base = `iso:${pack}:${String(shard)}`;
  // The full set lists only the code this shard uses at all.
  const engine = facts.some((f) => f.kind === 'p') ? [PROCEDURAL_ENGINE, RUNTIME_SCRIPTS.procedural] : [];
  const usesJs = facts.some((f) => f.kind === 'j');
  const before = usesJs ? commonFile : [];
  const scriptlets = usesJs ? [scriptletCodePath(pack, 'ISOLATED')] : [];
  return [
    ...(plain.length === 0 ? [] : [{ id: base, world, js: [isolatedDataPath(pack, shard), RUNTIME_SCRIPTS.cosmetic], hosts: plain }]),
    ...(full.length === 0 ? [] : [{ id: `${base}:f`, world, js: [...before, isolatedDataPath(pack, shard), ...engine, ...scriptlets, RUNTIME_SCRIPTS.cosmetic], hosts: full }]),
  ];
}

/** Invocation values (`j`) used in more than one shard: packaged once in the common table. */
function commonInvocations(shards: ReadonlyMap<number, readonly Fact[]>): ReadonlyMap<string, number> {
  const seen = new Map<string, number>();
  for (const facts of shards.values()) for (const v of new Set(facts.filter((f) => f.kind === 'j').map((f) => f.value))) seen.set(v, (seen.get(v) ?? 0) + 1);
  return new Map([...seen].filter(([, n]) => n > 1).map(([v]) => v).sort(byString).map((v, i) => [v, i]));
}

/** Data files and registrations of one world of one pack, with `count` shards. */
function emitWithCount(input: PackInput, world: ScriptWorld, facts: readonly Fact[], count: number, offset: number) {
  const files = new Map<string, string>();
  const registrations: CatalogRegistration[] = [];
  const wrap = shardFileWrap(world);
  // MAIN: the first file of a registration starts a fresh holder (security review M1): the common table
  // when the shard uses it, else the shard's own data file.
  const lead = shardFileWrap(world, true);
  const shards = groupByShard(facts, count, offset);
  const common = commonInvocations(shards);
  if (common.size > 0) {
    const data: CommonData = { v: SHARD_DATA_VERSION, pack: input.pack, common: true, invocations: [...common.keys()].map(invocationOf((n) => input.fnIndex(world, n))) };
    files.set(commonDataPath(input.pack, world), `${lead.prefix}${JSON.stringify(data)}${lead.suffix}`);
  }
  for (const [shard, shardFacts] of [...shards].sort(([a], [b]) => a - b)) {
    const regs = registrationsOf(input.pack, shard, world, shardFacts, common);
    if (regs.length === 0) continue;
    const data = shardData(input.pack, shard, shardFacts, (name) => input.fnIndex(world, name), common);
    const usesCommon = shardFacts.some((f) => (f.kind === 'j' || f.kind === 'n') && common.has(f.value));
    const w = usesCommon ? wrap : lead;
    files.set(world === 'MAIN' ? mainDataPath(input.pack, shard) : isolatedDataPath(input.pack, shard), `${w.prefix}${JSON.stringify(data)}${w.suffix}`);
    registrations.push(...regs);
  }
  return { files, registrations };
}

const sizesOf = (files: ReadonlyMap<string, string>): number[] =>
  [...files].filter(([p]) => !p.endsWith('/common.js')).map(([, t]) => Buffer.byteLength(t));

/** How a lane's shard count is chosen: by mean and worst size, or (code repeated per shard) by the worst only. */
type Sizing = 'mean' | 'worst';

interface Lane {
  readonly files: ReadonlyMap<string, string>;
  readonly registrations: readonly CatalogRegistration[];
  readonly count: number;
}

/**
 * Shard count scaled to the data (D-23, D-41): the smallest count up to the cap (searched in ≈ 10 % steps)
 * whose worst shard is ≤ `SHARD_TARGET_WORST_BYTES` and, for `mean` sizing, whose mean shard is ≤
 * `SHARD_TARGET_MEAN_BYTES`; a step that no longer shrinks the worst shard stops the search once every shard is
 * inside the 64 KiB hard gate. Shards are numbered from `offset`.
 */
function emitLane(input: PackInput, world: ScriptWorld, facts: readonly Fact[], sizing: Sizing, offset: number): Lane {
  if (facts.length === 0) return { files: new Map(), registrations: [], count: 0 };
  const max = Math.min(input.maxShards ?? SHARD_COUNT, SHARD_COUNT);
  const one = emitWithCount(input, world, facts, 1, offset);
  const total = sizesOf(one.files).reduce((a, b) => a + b, 0);
  const meanTarget = sizing === 'worst' ? Number.POSITIVE_INFINITY : SHARD_TARGET_MEAN_BYTES;
  // Balanced shards (D-41): start at the count the targets imply, then grow by about 10 % until they hold.
  let count = Math.min(max, Math.max(1, Math.ceil(total / Math.min(meanTarget, SHARD_TARGET_WORST_BYTES))));
  let previous: Lane | null = null;
  for (;;) {
    const out = count === 1 ? one : emitWithCount(input, world, facts, count, offset);
    const sizes = sizesOf(out.files);
    const worst = Math.max(0, ...sizes);
    const mean = sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length);
    // One heavy site cannot be split (its hosts share a shard): when doubling no longer shrinks the worst
    // shard, more registrations only repeat the code (D-41). The 64 KiB hard gate still applies.
    if (previous !== null && worstOf(previous) <= MAX_SHARD_BYTES && worst >= worstOf(previous) * NO_GAIN) return previous;
    if (count >= max || (mean <= meanTarget && worst <= SHARD_TARGET_WORST_BYTES)) return { ...out, count };
    previous = { ...out, count };
    count = Math.min(Math.max(count + 1, Math.ceil(count * GROWTH)), max);
  }
}

/** Growing the count must cut the worst shard below this share of the previous one to be worth its registrations. */
const NO_GAIN = 0.97;
/** Step of the shard count search. */
const GROWTH = 1.1;
const worstOf = (lane: Lane): number => Math.max(0, ...sizesOf(lane.files));

/**
 * ISOLATED (D-41): hosts whose site needs code (procedural engine or ISOLATED scriptlets) and hosts that need
 * only the applier are sharded separately, so the code is repeated only in the code lane's few registrations;
 * the plain lane is sized by mean and worst, the code lane by the worst shard only.
 */
function emitIsolated(input: PackInput): Lane {
  const needsCode = new Set(input.isolated.filter((f) => f.kind === 'p' || f.kind === 'j').map((f) => tail(f.host)));
  const plain = emitLane(input, 'ISOLATED', input.isolated.filter((f) => !needsCode.has(tail(f.host))), 'mean', 0);
  const full = emitLane(input, 'ISOLATED', input.isolated.filter((f) => needsCode.has(tail(f.host))), 'worst', plain.count);
  return { files: new Map([...plain.files, ...full.files]), registrations: [...plain.registrations, ...full.registrations], count: plain.count + full.count };
}

/** Everything one pack registers. MAIN shards each repeat the pack's scriptlet code, so the worst shard sizes them. */
export function emitPackContent(input: PackInput): PackContent {
  const iso = emitIsolated(input);
  const main = emitLane(input, 'MAIN', input.main, 'worst', 0);
  const files = new Map([...iso.files, ...main.files]);
  const registrations = [...main.registrations, ...iso.registrations];
  return {
    files, registrations,
    patterns: registrations.reduce((n, r) => n + r.hosts.length, 0),
    worstShardBytes: Math.max(0, ...[...files.values()].map((t) => Buffer.byteLength(t))),
  };
}
