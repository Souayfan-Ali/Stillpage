/**
 * Which registrations persist across browser sessions (P2-65, D-79, S-23). Chrome re-processes the patterns of
 * every persistent registration on each register, update or unregister call, on its UI thread, at a cost that
 * grows with their square: 36,735 persistent patterns froze the browser ≈ 1.6 s per call (a level change to or
 * from Thorough, a pack toggle). So only a core tier of at most `PERSISTENT_PATTERN_CAP` patterns persists:
 * the pop-up guard, GPC, the notification gate, then MAIN-world scriptlet shards of the default packs (malware,
 * trackers, ads), then of any other pack, so an optional pack never pushes the default ones out.
 * Everything else is session-scoped and restored by the startup reconcile (ADR-020): a tab restored at browser
 * start may miss it for about a second.
 */
import type { ScriptRegistration } from './types.js';

const POPUP_GUARD_PREFIX = 'popup-';
const MAIN_SHARD = /^main:([^:]+):/;
/** Default packs whose MAIN-world shards come first, in this order (review M3: an optional pack cannot starve them). */
const DEFAULT_MAIN_PACKS: readonly string[] = ['malware', 'trackers', 'ads'];
const FIRST_PACK_RANK = 3;
const NOT_IN_TIER = Number.POSITIVE_INFINITY;

/** The tier rank of a registration id; lower ranks fill the cap first. */
function rank(id: string): number {
  if (id.startsWith(POPUP_GUARD_PREFIX)) return 0;
  if (id === 'gpc') return 1;
  if (id === 'notify-gate') return 2;
  const pack = MAIN_SHARD.exec(id)?.[1];
  if (pack === undefined) return NOT_IN_TIER;
  const index = DEFAULT_MAIN_PACKS.indexOf(pack);
  return FIRST_PACK_RANK + (index === -1 ? DEFAULT_MAIN_PACKS.length : index);
}

const patternsOf = (s: ScriptRegistration): number => s.matches.length + s.excludeMatches.length;

/** Patterns over the persistent registrations of `list`. */
export function persistentPatterns(list: readonly ScriptRegistration[]): number {
  return list.reduce((sum, s) => (s.persistAcrossSessions ? sum + patternsOf(s) : sum), 0);
}

/** The ids that persist: tier order (rank, then id), greedily up to `cap` patterns. */
function tierIds(list: readonly ScriptRegistration[], cap: number): ReadonlySet<string> {
  const candidates = list
    .filter((s) => rank(s.id) !== NOT_IN_TIER)
    .sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const chosen = candidates.reduce<{ readonly used: number; readonly ids: readonly string[] }>((acc, s) => {
    const next = acc.used + patternsOf(s);
    return next > cap ? acc : { used: next, ids: [...acc.ids, s.id] };
  }, { used: 0, ids: [] });
  return new Set(chosen.ids);
}

/** `list` in the same order, each registration marked persistent only when it is in the capped core tier. */
export function withPersistence(list: readonly ScriptRegistration[], cap: number): readonly ScriptRegistration[] {
  const keep = tierIds(list, cap);
  return list.map((s) => ({ ...s, persistAcrossSessions: keep.has(s.id) }));
}
