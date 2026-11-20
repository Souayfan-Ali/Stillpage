/**
 * Stages 2–5 for the network rulesets (filter-pipeline notes §2): parse every list, collect `$badfilter` over the
 * whole build, then per ruleset normalise → convert → dedupe → shift priorities → bucket → split
 * safe / unsafe. Pure over the list texts (the converter is deterministic); I/O lives in the CLI.
 */
import type { ListsConfig, RulesetConfig } from '../config/schema.js';
import { convertRuleset } from '../convert/convert.js';
import { cancelKey, collectBadfilters, isBadfilter, isBadfiltered, type BadfilterSet } from '../normalise/badfilter.js';
import { normaliseRuleset, type LogEntry } from '../normalise/normalise.js';
import { parseList, type Entry } from '../parse/parse-list.js';
import { bucketRuleset } from '../postpass/buckets.js';
import { gpcRules } from '../gpc/rule.js';
import { dedupe } from '../postpass/dedupe.js';
import { mergeRemoveParams, removeparamAsUrlFilter } from '../postpass/removeparam.js';
import { shiftStockPriorities } from '../postpass/priorities.js';
import { resolveRedirects } from '../surrogates/redirects.js';
import { assertPurity, assertRedirectsCovered, splitSafeUnsafe, type SplitRuleset } from '../postpass/split.js';

export interface NetworkRuleset extends SplitRuleset {
  readonly config: RulesetConfig;
  /** Rule count with a single bucket, for the bucket-overhead gate (ADR-011). */
  readonly maximal: number;
  /** `$popup` / `$popunder` / `$all` entries for the pop-up emitter (filter-pipeline notes §7a). */
  readonly popupEntries: readonly Entry[];
  /** Cosmetic and scriptlet entries for the later emitters. */
  readonly rest: readonly Entry[];
  readonly log: readonly LogEntry[];
  /** `redirect=none` rules compiled as blocks (P1-30). */
  readonly redirectNone: number;
  /** Network filter lines seen (for the extra-rejection figure). */
  readonly networkFilters: number;
}

/** `$all` filters: the converter compiles them, and their host is also a pop-up destination (pop-up notes §6.1). */
const isAllFilter = (e: Entry): boolean =>
  e.kind === 'network' && e.node?.category === 'Network' && e.node.type === 'NetworkRule'
  && (e.node.modifiers?.children ?? []).some((m) => m.name.value === 'all' && m.exception !== true);

/** Parses every list of `config` from `texts` (list id → text). */
export function parseAll(config: ListsConfig, texts: ReadonlyMap<string, string>): ReadonlyMap<string, readonly Entry[]> {
  return new Map(config.lists.map((list) => {
    const text = texts.get(list.id);
    if (text === undefined) throw new Error(`no text for list "${list.id}"`);
    return [list.id, parseList(list, text).entries];
  }));
}

async function compileRuleset(config: RulesetConfig, entries: readonly Entry[], bad: ReadonlySet<string>,
  entityOf: (host: string) => string | undefined, redirects?: ReadonlyMap<string, string>): Promise<NetworkRuleset> {
  const n = normaliseRuleset(entries, bad);
  const raw = await convertRuleset(n.inputs);
  const resolved = redirects === undefined ? { rules: raw.rules, log: [], none: 0 } : resolveRedirects(raw.rules, redirects);
  const converted = { ...raw, rules: mergeRemoveParams(removeparamAsUrlFilter(resolved.rules)), log: [...raw.log, ...resolved.log] };
  const shifted = shiftStockPriorities(dedupe(converted.rules).rules);
  const bucketed = bucketRuleset(shifted, entityOf, config.category);
  const split = splitSafeUnsafe(bucketed.rules);
  assertPurity(config.id, split.safe, split.unsafe);
  assertRedirectsCovered(config.id, split.safe, split.unsafe);
  const allEntries = entries.filter((e) => isAllFilter(e) && !isBadfilter(e) && !isBadfiltered(e, bad));
  return {
    ...split, config, maximal: bucketed.maximal, popupEntries: [...n.popups, ...allEntries], rest: n.rest,
    log: [...n.log, ...converted.log], redirectNone: resolved.none,
    networkFilters: entries.filter((e) => e.kind === 'network' || e.kind === 'network.popup' || e.kind === 'network.host').length,
  };
}

/** The `$badfilter` sets in force per pack (P2-27, design review 2026-11-14), and the out-of-pack ones logged. */
interface BadfilterScopes {
  readonly forPack: (pack: string) => BadfilterSet;
  readonly log: ReadonlyMap<string, readonly LogEntry[]>;
}

/**
 * Default packs' `$badfilter` lines (and the overrides') cancel build-wide, as uBO does. An optional
 * pack's apply only inside that pack, so an opt-in list never removes a default rule while it is off;
 * one whose target is not in its own pack is logged (`badfilter-outside-pack`).
 */
function badfilterScopes(config: ListsConfig, parsed: ReadonlyMap<string, readonly Entry[]>, overrides: ReadonlyMap<string, readonly Entry[]>): BadfilterScopes {
  const entriesOf = (pack: string): readonly Entry[] =>
    config.rulesets.filter((r) => r.pack === pack).flatMap((r) => r.lists).flatMap((id) => parsed.get(id) ?? []);
  const packs = [...new Set(config.rulesets.map((r) => r.pack))];
  const isDefault = (pack: string): boolean => config.packs[pack]?.default ?? false;
  const global = collectBadfilters([...packs.filter(isDefault).flatMap(entriesOf), ...[...overrides.values()].flat()]);
  const scoped = new Map<string, BadfilterSet>();
  const log = new Map<string, readonly LogEntry[]>();
  for (const pack of packs.filter((p) => !isDefault(p))) {
    const own = entriesOf(pack);
    const targets = new Set(own.map(cancelKey).filter((k): k is string => k !== null));
    const outside = own.filter((e) => isBadfilter(e) && !targets.has([...collectBadfilters([e])][0] ?? ''));
    scoped.set(pack, new Set([...global, ...collectBadfilters(own)]));
    log.set(pack, outside.map((e) => ({ source: e.source, reason: 'badfilter-outside-pack' as const })));
  }
  return { forPack: (pack) => scoped.get(pack) ?? global, log };
}

/**
 * Compiles every configured ruleset, in config order. `overrides` (ruleset id → entries, P2-08) join their
 * ruleset's list entries before normalisation; their `$badfilter` lines cancel filters build-wide.
 */
export async function compileNetwork(config: ListsConfig, parsed: ReadonlyMap<string, readonly Entry[]>,
  entityOf: (host: string) => string | undefined, redirects?: ReadonlyMap<string, string>,
  overrides: ReadonlyMap<string, readonly Entry[]> = new Map()): Promise<readonly NetworkRuleset[]> {
  const scopes = badfilterScopes(config, parsed, overrides);
  const logged = new Set<string>();
  const out: NetworkRuleset[] = [];
  for (const rs of config.rulesets) {
    const entries = [...rs.lists.flatMap((id) => parsed.get(id) ?? []), ...(overrides.get(rs.id) ?? [])];
    const built = await compileRuleset(rs, entries, scopes.forPack(rs.pack), entityOf, redirects);
    const compiled = rs.builtin === 'gpc' ? { ...built, unsafe: [...built.unsafe, ...gpcRules(rs.category)] } : built;
    // The out-of-pack log goes with the pack's first ruleset only.
    const extra = logged.has(rs.pack) ? [] : (scopes.log.get(rs.pack) ?? []);
    logged.add(rs.pack);
    out.push({ ...compiled, log: [...compiled.log, ...extra] });
  }
  return out;
}
