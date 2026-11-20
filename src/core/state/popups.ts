/** Pop-up settings changes (P2-54, architecture notes §5.2, ADR-016). Pure; every result is a new object. */
import type { Hostname } from '../ids.js';
import { MAX_SITES_PER_LEVEL } from '../limits.js';
import type { PopupMode, Settings } from './types.js';

/** The per-site choice a command may make; `inherit` removes the site's policy. */
export type SitePopupChoice = 'allow' | 'strict' | 'inherit';

export function withPopupMode(settings: Settings, mode: PopupMode): Settings {
  return { ...settings, popups: { ...settings.popups, mode } };
}

/** Settings with the in-page notice on or off (P2-60b). */
export function withPopupNotice(settings: Settings, notice: boolean): Settings {
  return { ...settings, popups: { ...settings.popups, notice } };
}

/** Settings with the site's policy set or removed; `null` when a new site would cross the cap. */
export function withSitePopupPolicy(settings: Settings, host: Hostname, choice: SitePopupChoice): Settings | null {
  const rest = Object.fromEntries(Object.entries(settings.popups.sites).filter(([site]) => site !== host)) as Settings['popups']['sites'];
  if (choice === 'inherit') return { ...settings, popups: { ...settings.popups, sites: rest } };
  const isNew = !Object.hasOwn(settings.popups.sites, host);
  if (isNew && Object.keys(rest).length >= MAX_SITES_PER_LEVEL) return null;
  return { ...settings, popups: { ...settings.popups, sites: { ...rest, [host]: choice } } };
}
