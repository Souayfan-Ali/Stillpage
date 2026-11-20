/**
 * Level roots: the smallest set of explicitly set hosts whose subtrees share a level bound.
 * Because levels are monotone down the tree (resolve.ts), "every host at or below Light" is exactly
 * the union of the subtrees of these roots, which is what `excludeMatches` and `requestDomains` express.
 */
import { parentDomains } from '../hostname/walk.js';
import type { Hostname } from '../ids.js';
import { LEVELS, type EpochMs, type Level, type Settings } from '../state/types.js';
import { resolveLevel } from './resolve.js';
import { own } from '../record.js';

/** Hosts with a site level or an active pause, sorted. */
function explicitHosts(settings: Settings, now: EpochMs): readonly Hostname[] {
  const paused = (Object.keys(settings.pauses) as Hostname[]).filter(
    (host) => (own(settings.pauses, host)?.until ?? 0) > now,
  );
  return [...new Set([...(Object.keys(settings.siteLevels) as Hostname[]), ...paused])].sort();
}

/** Drops every host that has a strict ancestor in the same list. */
function minimalHosts(hosts: readonly Hostname[]): readonly Hostname[] {
  const set = new Set(hosts);
  return hosts.filter((host) => !parentDomains(host).slice(1).some((parent) => set.has(parent)));
}

function rootsWhere(settings: Settings, now: EpochMs, keep: (rank: number) => boolean): readonly Hostname[] {
  const matching = explicitHosts(settings, now).filter((host) =>
    keep(LEVELS.indexOf(resolveLevel(settings, host, now).level)),
  );
  return minimalHosts(matching);
}

/** Roots of the subtrees whose effective level is `level` or lower. */
export function rootsAtOrBelow(settings: Settings, now: EpochMs, level: Level): readonly Hostname[] {
  return rootsWhere(settings, now, (rank) => rank <= LEVELS.indexOf(level));
}

/** Roots of the subtrees explicitly raised to `level` or higher. */
export function rootsAtOrAbove(settings: Settings, now: EpochMs, level: Level): readonly Hostname[] {
  return rootsWhere(settings, now, (rank) => rank >= LEVELS.indexOf(level));
}
