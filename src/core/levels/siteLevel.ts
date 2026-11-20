/**
 * `c/setSiteLevel` as a pure settings change (P1-41, ADR-015). An explicit level is stored on the host
 * as is; inheritance (effective = min of the host and its parents, `resolve.ts`) is applied when the
 * level is read, so a child set above a lower parent stays stored and comes back when the parent is
 * raised. `inherit` is what the panel's "Turn on" and "Resume now" send: it removes the host's pause
 * and its own level, except that resuming from an active pause keeps a level the user chose there
 * (anything but Off), so a resume never throws away a Light or Thorough choice.
 */
import type { Hostname } from '../ids.js';
import { own } from '../record.js';
import type { EpochMs, Level, Settings } from '../state/types.js';

/** A level to store on the host, or `inherit` to fall back to its parents and the default. */
export type SiteLevelChoice = Level | 'inherit';

function without<V>(record: Readonly<Record<Hostname, V>>, host: Hostname): Readonly<Record<Hostname, V>> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== host));
}

/** Returns new settings with `choice` applied to `host` at time `now`. */
export function withSiteLevel(settings: Settings, host: Hostname, choice: SiteLevelChoice, now: EpochMs): Settings {
  if (choice !== 'inherit') {
    return { ...settings, siteLevels: { ...settings.siteLevels, [host]: choice } };
  }
  const wasPaused = (own(settings.pauses, host)?.until ?? 0) > now;
  const level = own(settings.siteLevels, host);
  const keepLevel = wasPaused && level !== undefined && level !== 'off';
  return {
    ...settings,
    siteLevels: keepLevel ? settings.siteLevels : without(settings.siteLevels, host),
    pauses: without(settings.pauses, host),
  };
}
