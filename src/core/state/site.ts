/**
 * Per-site settings changes and reads for the toolbar panel (P2-10, P2-14). Pure; every result is a
 * new object.
 *
 * - `withPause`: the pause menu (UI notes §3). 30 or 60 minutes store a pause the worker ends with its
 *   alarm; "until I turn it back on" (`null`) stores Off on the host, so the panel shows "Off on this
 *   site / Turn back on" and the label and stored state agree (design review, P2-10).
 * - `siteSnapshotOf`: the host's own stored values, which the breakage flow compares before it undoes
 *   a trial (P2-13 compare-and-revert).
 */
import type { Hostname } from '../ids.js';
import { MAX_SITES_PER_LEVEL } from '../limits.js';
import { own } from '../record.js';
import type { EpochMs, Level, Settings } from './types.js';

/** Pause lengths the menu offers; `null` is "until I turn it back on". */
export type PauseChoice = 30 | 60 | null;

const MINUTE_MS = 60_000;

/** The host's own values: its stored level, pop-up policy and active pause, each `null` when unset. */
export interface SiteSnapshot {
  readonly ownLevel: Level | null;
  readonly popupPolicy: 'allow' | 'strict' | null;
  readonly pausedUntil: EpochMs | null;
}

function activePauses(settings: Settings, now: EpochMs, except: Hostname): Settings['pauses'] {
  return Object.fromEntries(Object.entries(settings.pauses).filter(([host, pause]) => host !== except && pause.until > now));
}

/** Settings after a pause choice on `host`; `null` when a new pause would cross the site cap. */
export function withPause(settings: Settings, host: Hostname, choice: PauseChoice, now: EpochMs): Settings | null {
  const others = activePauses(settings, now, host);
  if (choice === null) return { ...settings, siteLevels: { ...settings.siteLevels, [host]: 'off' }, pauses: others };
  if (Object.keys(others).length >= MAX_SITES_PER_LEVEL) return null;
  return { ...settings, pauses: { ...others, [host]: { until: now + choice * MINUTE_MS } } };
}

export function siteSnapshotOf(settings: Settings, host: Hostname, now: EpochMs): SiteSnapshot {
  const until = own(settings.pauses, host)?.until ?? null;
  return {
    ownLevel: own(settings.siteLevels, host) ?? null,
    popupPolicy: own(settings.popups.sites, host) ?? null,
    pausedUntil: until !== null && until > now ? until : null,
  };
}
