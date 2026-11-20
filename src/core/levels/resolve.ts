/**
 * Level resolution with inheritance (P1-04, ADR-015).
 *
 * Levels are monotone down the domain tree: effective = min(every level explicitly set on the host
 * and its parents), falling back to the global default when none is set. Each lowering is an
 * `excludeMatches` / `allowAllRequests` exclusion that covers every subdomain and cannot be
 * re-included, so a child can never be above an explicit ancestor (design decision, P1-04 notes;
 * ADR-015's "Off on a parent cannot be overridden" generalised). Child settings above the cap stay
 * stored and come back when the parent is raised. An active pause is Off on its subtree.
 */
import type { Hostname } from '../ids.js';
import { parentDomains } from '../hostname/walk.js';
import { LEVELS, type EpochMs, type Level, type Settings } from '../state/types.js';
import { own } from '../record.js';

/** The effective level of a host and where it comes from. */
export interface ResolvedLevel {
  readonly level: Level;
  /** Host whose setting or pause decided the level; `null` when it is the global default. */
  readonly setOn: Hostname | null;
  /** Expiry of the pause that decided the level, if any. */
  readonly pausedUntil: EpochMs | null;
}

/** The lower of two levels. */
export function minLevel(a: Level, b: Level): Level {
  return LEVELS.indexOf(a) <= LEVELS.indexOf(b) ? a : b;
}

/** True when `level` is strictly lower than `than`, or `than` is absent. */
function isBelow(level: Level, than: Level | undefined): boolean {
  return than === undefined || LEVELS.indexOf(level) < LEVELS.indexOf(than);
}

function activePauseOn(settings: Settings, chain: readonly Hostname[], now: EpochMs): ResolvedLevel | null {
  const paused = chain.find((name) => (own(settings.pauses, name)?.until ?? 0) > now);
  const until = paused === undefined ? undefined : own(settings.pauses, paused)?.until;
  return paused === undefined || until === undefined ? null : { level: 'off', setOn: paused, pausedUntil: until };
}

/** Resolves the effective level of `host` at time `now`. */
export function resolveLevel(settings: Settings, host: Hostname, now: EpochMs): ResolvedLevel {
  const chain = parentDomains(host);
  // Nearest first; a later (higher-up) entry wins only when strictly lower, so ties keep the nearest.
  const explicit = chain.reduce<ResolvedLevel | null>((best, name) => {
    const level = own(settings.siteLevels, name);
    if (level === undefined) return best;
    return isBelow(level, best?.level) ? { level, setOn: name, pausedUntil: null } : best;
  }, null);
  if (explicit?.level === 'off') return explicit;
  return activePauseOn(settings, chain, now) ?? explicit ?? { level: settings.defaultLevel, setOn: null, pausedUntil: null };
}

/** Earliest pause expiry after `now` (for the pause alarm), or `null` when no pause is active. */
export function nextPauseExpiry(settings: Settings, now: EpochMs): EpochMs | null {
  const future = Object.values(settings.pauses)
    .map((pause) => pause.until)
    .filter((until) => until > now);
  return future.length > 0 ? Math.min(...future) : null;
}
