/**
 * The Sites table's rows (P2-35, UI notes §8): every host with a stored level, an active pause or a
 * pop-up policy, sorted by name, filtered by the search text. Also the add form's check. Pure.
 */
import { parseHostname } from '../../../core/hostname/validate.js';
import type { Hostname } from '../../../core/ids.js';
import { MAX_SITES_PER_LEVEL } from '../../../core/limits.js';
import { own } from '../../../core/record.js';
import type { EpochMs, Level, Settings } from '../../../core/state/types.js';

export interface SiteRow {
  readonly host: Hostname;
  /** The host's own level; `null` when it inherits. */
  readonly level: Level | null;
  /** End of an active pause; `null` when not paused. */
  readonly pausedUntil: EpochMs | null;
  readonly popupPolicy: 'allow' | 'strict' | null;
}

function activePause(settings: Settings, host: Hostname, now: EpochMs): EpochMs | null {
  const until = own(settings.pauses, host)?.until ?? 0;
  return until > now ? until : null;
}

export function siteRows(settings: Settings, now: EpochMs, search = ''): readonly SiteRow[] {
  const paused = Object.entries(settings.pauses).filter(([, pause]) => pause.until > now);
  const hosts = new Set([...Object.keys(settings.siteLevels), ...paused.map(([host]) => host), ...Object.keys(settings.popups.sites)] as Hostname[]);
  const needle = search.trim().toLowerCase();
  return [...hosts]
    .filter((host) => needle === '' || host.includes(needle))
    .sort((a, b) => a.localeCompare(b))
    .map((host) => ({
      host,
      level: own(settings.siteLevels, host) ?? null,
      pausedUntil: activePause(settings, host, now),
      popupPolicy: own(settings.popups.sites, host) ?? null,
    }));
}

export type AddProblem = 'invalid' | 'full';

/** The host to add, or why it cannot be added (the same `parseHostname` the worker uses; the level cap). */
export function checkNewSite(settings: Settings, text: string, level: Level): { readonly ok: true; readonly host: Hostname } | { readonly ok: false; readonly problem: AddProblem } {
  const host = parseHostname(text.trim());
  if (host === null) return { ok: false, problem: 'invalid' };
  const atLevel = Object.entries(settings.siteLevels).filter(([h, l]) => l === level && h !== host).length;
  return atLevel >= MAX_SITES_PER_LEVEL ? { ok: false, problem: 'full' } : { ok: true, host };
}
