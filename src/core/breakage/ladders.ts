/**
 * The ladders of the breakage flow (UI notes §6) and what each remedy changes. A step is a list of
 * options: "ad got through" offers the picker and Thorough side by side at step 2.
 */
import type { Hostname } from '../ids.js';
import type { ResolvedLevel } from '../levels/resolve.js';
import { LEVELS, type EpochMs, type Level } from '../state/types.js';
import type { Availability, Change, Complaint, Remedy, SiteSnapshot } from './types.js';

/** "Pause 30 minutes" (UI notes §6, anti-adblock step 2). */
export const PAUSE_TRIAL_MS = 30 * 60_000;

export const LADDERS: Readonly<Record<Complaint, readonly (readonly Remedy[])[]>> = {
  broken: [['allowPopups'], ['light'], ['off']],
  adThrough: [['reload'], ['picker', 'thorough']],
  antiAdblock: [['thorough'], ['pause']],
  popupOpened: [['reload'], ['strictPopups']],
};

/** What the caller knows about the host when it asks whether a remedy would change anything. */
export interface AvailabilityContext {
  readonly host: Hostname;
  readonly level: ResolvedLevel;
  readonly siteAccess: boolean;
  readonly popupPolicy: 'allow' | 'strict' | null;
  /** The pop-up guard scripts ship in this build (P2-58 switch); Strict per site needs them. */
  readonly guardShipped: boolean;
}

const below = (a: Level, b: Level): boolean => LEVELS.indexOf(a) < LEVELS.indexOf(b);

/** Whether `remedy` would change anything on the host (design review, P2-13: unavailable steps are skipped). */
export function remedyAvailability(remedy: Remedy, ctx: AvailabilityContext): Availability {
  const { level, setOn } = ctx.level;
  switch (remedy) {
    case 'light':
      return below('light', level) ? 'available' : 'noop';
    case 'off':
    case 'pause':
      return level === 'off' ? 'noop' : 'available';
    case 'thorough':
      if (level === 'thorough') return 'noop';
      if (!ctx.siteAccess) return 'needs-site-access';
      return setOn !== null && setOn !== ctx.host ? 'capped-by-parent' : 'available';
    case 'allowPopups':
      return ctx.popupPolicy === 'allow' ? 'noop' : 'available';
    case 'strictPopups':
      if (ctx.popupPolicy === 'strict') return 'noop';
      return ctx.guardShipped ? 'available' : 'needs-guard';
    case 'reload':
    case 'picker':
      return 'available';
  }
}

/** The settings change a remedy applies on `host`, or `null` for reload and the picker. */
export function changeOf(remedy: Remedy, host: Hostname, now: EpochMs): Change | null {
  switch (remedy) {
    case 'light':
    case 'off':
    case 'thorough':
      return { kind: 'siteLevel', host, level: remedy };
    case 'allowPopups':
      return { kind: 'popupPolicy', host, policy: 'allow' };
    case 'strictPopups':
      return { kind: 'popupPolicy', host, policy: 'strict' };
    case 'pause':
      return { kind: 'pause', host, until: now + PAUSE_TRIAL_MS };
    case 'reload':
    case 'picker':
      return null;
  }
}

/** The same field as `change`, holding the host's current value. */
export function currentOf(change: Change, snapshot: SiteSnapshot): Change {
  switch (change.kind) {
    case 'siteLevel':
      return { ...change, level: snapshot.ownLevel ?? 'inherit' };
    case 'popupPolicy':
      return { ...change, policy: snapshot.popupPolicy };
    case 'pause':
      return { ...change, until: snapshot.pausedUntil };
  }
}

/** Same kind, host and value. */
export function sameChange(a: Change, b: Change): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
