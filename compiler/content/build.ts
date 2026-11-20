/**
 * Content build (P1-27…P1-29): cosmetic and scriptlet entries of every ruleset → facts per pack →
 * cross-pack exception resolution → shard files, scriptlet code and registrations, plus the counts
 * the build report and the verify stage need (patterns, registrations, worst shard, fail-open
 * exceptions, lost entities).
 */
import type { CatalogRegistration, ScriptWorld } from '../../src/core/catalog/registrations.js';
import { scriptletCodePath } from '../../src/core/content/files.js';
import { REGIONAL_SHARD_COUNT, SHARD_COUNT } from '../../src/core/limits.js';
import type { RulesetConfig } from '../config/schema.js';
import type { LogEntry } from '../normalise/normalise.js';
import type { Entry } from '../parse/parse-list.js';
import type { UboParser } from '../vendor/ubo.js';
import { isSiteHost } from '../entities/hosts.js';
import { cosmeticFacts, type HostContext } from './cosmetic.js';
import { dedupeFacts, resolveExceptions, type Fact, type ResolvedFacts } from './facts.js';
import { emitGeneric, genericEntry, genericSwitchHost, type GenericBuild, type GenericEntry, type GenericStats } from './generic.js';
import { emitPackContent } from './shards.js';

/** The content entries of one ruleset, as the network compile left them (`rest`). */
export interface ContentSource {
  readonly config: Pick<RulesetConfig, 'id' | 'pack'> & Partial<Pick<RulesetConfig, 'category'>>;
  readonly entries: readonly Entry[];
}

/** Scriptlet side (P1-29): facts of one entry and the code file of a pack and world. */
export interface ScriptletPort {
  readonly facts: (entry: Entry, ctx: HostContext) => { readonly isolated: readonly Fact[]; readonly main: readonly Fact[]; readonly log: readonly LogEntry[]; readonly lostEntities: readonly string[] };
  readonly code: (pack: string, world: ScriptWorld, names: readonly string[]) => { readonly text: string; readonly index: ReadonlyMap<string, number> };
  /** Replaces `#@#+js()` wildcards in `facts` by concrete exceptions for the invocations of `pool`. */
  readonly expand: (facts: readonly Fact[], pool: readonly Fact[]) => readonly Fact[];
}

const noScriptlets: ScriptletPort = {
  facts: () => ({ isolated: [], main: [], log: [], lostEntities: [] }),
  code: () => { throw new Error('no scriptlet library'); },
  expand: (facts) => facts,
};

export interface ContentBuild {
  readonly files: ReadonlyMap<string, string>;
  /** Pack id → its registrations (main first). */
  readonly registrations: ReadonlyMap<string, readonly CatalogRegistration[]>;
  readonly log: readonly LogEntry[];
  readonly stats: {
    readonly patterns: Readonly<Record<string, number>>;
    readonly registrations: Readonly<Record<string, number>>;
    readonly worstShardBytes: number;
    readonly failOpenExceptions: number;
    readonly removedByExceptions: number;
    readonly unresolvedExceptions: number;
    readonly lostEntities: readonly string[];
    readonly facts: Readonly<Record<string, number>>;
    readonly generic: Readonly<Record<string, GenericStats>>;
  };
  /** Generic cosmetic data (P2-23): packaged files per pack and the `$generichide` hosts. */
  readonly generic: Pick<GenericBuild, 'packs' | 'off'>;
}

/** `@@||host^$elemhide` / `$specifichide` (and short forms): no specific cosmetic filter on that host. */
const SPECIFIC_SWITCH = /^@@\|\|([a-z0-9.-]+)\^\$(?:elemhide|ehide|specifichide|shide)$/;

/** Host of a specific-cosmetic switch, or null (`$generichide` is `genericSwitchHost`'s; others are logged). */
export function switchHost(entry: Entry): string | null {
  const host = SPECIFIC_SWITCH.exec(entry.source.text)?.[1];
  // Never a suffix (`com`) or anything that is not a site host: it would switch off a whole registry (review M4).
  return host !== undefined && isSiteHost(host) ? host : null;
}

const related = (a: string, b: string): boolean => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/**
 * Exceptions that switch a host off: one `u` fact on the switched host for every hide, style or
 * procedural value of that host, its parents or its sub-hosts (the build-time resolution then drops
 * the sub-host facts and keeps a run-time exception for inherited ones).
 */
export function switchFacts(hosts: readonly string[], facts: readonly Fact[]): readonly Fact[] {
  return hosts.flatMap((h) => facts.filter((f) => (f.kind === 'h' || f.kind === 's' || f.kind === 'p') && related(f.host, h))
    .map((f) => ({ ...f, host: h as Fact['host'], kind: 'u' as const })));
}

const COSMETIC = new Set(['cosmetic.specific', 'cosmetic.procedural', 'cosmetic.exception', 'cosmetic.generic']);

interface Collected { readonly iso: Fact[]; readonly main: Fact[]; readonly generic: GenericEntry[] }

/** Cosmetic switches of one entry: specific (`switched`), generic (`genericOff`), or logged as unsupported. */
function collectSwitch(e: Entry, switched: string[], genericOff: string[], logs: LogEntry[]): void {
  const [specific, generic] = [switchHost(e), genericSwitchHost(e)];
  if (specific !== null) switched.push(specific);
  if (generic !== null) genericOff.push(generic);
  if (specific === null && generic === null) logs.push({ source: e.source, reason: 'cosmetic-switch-unsupported' });
}

function collect(sources: readonly ContentSource[], ubo: UboParser, ctx: HostContext, scriptlets: ScriptletPort) {
  const perPack = new Map<string, Collected>();
  const switched: string[] = [];
  const genericOff: string[] = [];
  const logs: LogEntry[] = [];
  const lost: string[] = [];
  for (const s of sources) {
    const bucket = perPack.get(s.config.pack) ?? { iso: [], main: [], generic: [] };
    perPack.set(s.config.pack, bucket);
    for (const e of s.entries) {
      if (e.kind === 'html-filter') { logs.push({ source: e.source, reason: 'html-filter' }); continue; }
      if (e.kind === 'network.cosmetic-switch') { collectSwitch(e, switched, genericOff, logs); continue; }
      const generic = genericEntry(e, ubo, ctx);
      if (generic !== null) { bucket.generic.push(generic); logs.push(...generic.log); lost.push(...generic.lostEntities); continue; }
      const isCosmetic = COSMETIC.has(e.kind);
      if (!isCosmetic && e.kind !== 'scriptlet' && e.kind !== 'scriptlet.exception') continue;
      const r = isCosmetic ? (({ facts, ...x }) => ({ ...x, isolated: facts, main: [] }))(cosmeticFacts(e, ubo, ctx)) : scriptlets.facts(e, ctx);
      bucket.iso.push(...r.isolated);
      bucket.main.push(...r.main);
      logs.push(...r.log);
      lost.push(...r.lostEntities);
    }
  }
  // A cosmetic switch turns the host off for every pack (uBO applies it to all lists).
  for (const b of perPack.values()) for (const f of switchFacts(switched, b.iso)) b.iso.push(f);
  return { perPack, logs, lost, genericOff };
}

const isException = (f: Fact): boolean => f.kind === 'u' || f.kind === 'n';

/** Resolves one world of one pack against the exceptions of every pack. */
function resolveWorld(own: readonly Fact[], others: readonly Fact[]): ResolvedFacts {
  const ownExceptions = own.filter(isException);
  return resolveExceptions(dedupeFacts(own.filter((f) => !isException(f))), [...ownExceptions, ...others.filter(isException)], new Set(ownExceptions));
}

const namesOf = (facts: readonly Fact[]): string[] =>
  [...new Set(facts.filter((f) => f.kind === 'j').map((f) => (JSON.parse(f.value) as string[])[0] ?? ''))].sort();

/** Builds every pack's content. Packs are emitted in sorted order (deterministic). */
export function buildContent(sources: readonly ContentSource[], ubo: UboParser, ctx: HostContext, scriptlets: ScriptletPort = noScriptlets): ContentBuild {
  const collected = collect(sources, ubo, ctx, scriptlets);
  const { logs, lost } = collected;
  const regional = new Set(sources.filter((s) => s.config.category === 'regional').map((s) => s.config.pack));
  const generic = emitGeneric(new Map([...collected.perPack].map(([p, b]) => [p, b.generic])),
    [...collected.perPack.values()].flatMap((b) => b.iso.filter((f) => f.kind === 'u')), collected.genericOff);
  const pool = [...collected.perPack.values()];
  const perPack = new Map([...collected.perPack].map(([p, b]) => [p, {
    iso: scriptlets.expand(b.iso, pool.flatMap((x) => x.iso)), main: scriptlets.expand(b.main, pool.flatMap((x) => x.main)) }]));
  const files = new Map<string, string>(generic.files);
  const registrations = new Map<string, readonly CatalogRegistration[]>();
  const stats = { patterns: {} as Record<string, number>, registrations: {} as Record<string, number>, worstShardBytes: 0,
    failOpenExceptions: 0, removedByExceptions: 0, unresolvedExceptions: 0, facts: {} as Record<string, number> };
  for (const pack of [...perPack.keys()].sort()) {
    const b = perPack.get(pack) ?? { iso: [], main: [] };
    const others = [...perPack].filter(([p]) => p !== pack).map(([, x]) => x);
    const iso = resolveWorld(b.iso, others.flatMap((x) => x.iso));
    const main = resolveWorld(b.main, others.flatMap((x) => x.main));
    const codes = (['ISOLATED', 'MAIN'] as const).map((w) => {
      const names = namesOf(w === 'MAIN' ? main.facts : iso.facts);
      return [w, names.length === 0 ? undefined : scriptlets.code(pack, w, names)] as const;
    });
    for (const [w, c] of codes) if (c) files.set(scriptletCodePath(pack, w), c.text);
    const indexOf = new Map(codes);
    const fnIndex = (w: ScriptWorld, n: string): number => {
      const i = indexOf.get(w)?.index.get(n);
      if (i === undefined) throw new Error(`scriptlet "${n}" is not in the ${w} code file of pack "${pack}"`);
      return i;
    };
    const maxShards = regional.has(pack) ? REGIONAL_SHARD_COUNT : SHARD_COUNT;
    const out = emitPackContent({ pack, isolated: iso.facts, main: main.facts, fnIndex, maxShards });
    for (const [k, v] of out.files) files.set(k, v);
    registrations.set(pack, out.registrations);
    stats.patterns[pack] = out.patterns;
    stats.registrations[pack] = out.registrations.length;
    stats.worstShardBytes = Math.max(stats.worstShardBytes, out.worstShardBytes);
    stats.failOpenExceptions += iso.failOpen + main.failOpen;
    stats.removedByExceptions += iso.removed + main.removed;
    stats.unresolvedExceptions += iso.unresolved + main.unresolved;
    stats.facts[pack] = iso.facts.length + main.facts.length;
  }
  return { files, registrations, log: logs, stats: { ...stats, generic: generic.stats, lostEntities: [...new Set(lost)].sort() },
    generic: { packs: generic.packs, off: generic.off } };
}
