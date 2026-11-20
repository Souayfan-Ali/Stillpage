/** Default settings (architecture notes §5.2, ADR-015, Q-12, Q-21). */
import { SETTINGS_SCHEMA_VERSION, type PopupMode, type Settings } from './types.js';

/** The heuristic pop-up guard is opt-in in v1.0 (Q-21, D-13). Flipping it is a full release. */
export const POPUP_GUARD_DEFAULT: PopupMode = 'off';

/**
 * Sites the lists designate with `*$popup,domain=…` get the guard in Strict even while the guard is
 * off (ADR-016 item 3, pop-up notes §7.6; design review 2026-11-14, owner to confirm: it patches `window.open` on
 * those sites by default). Turning it off is this one line.
 */
export const POPUP_LIST_STRICT_DEFAULT = true;

/** Fresh, deeply frozen default settings. */
export function createDefaultSettings(): Settings {
  return Object.freeze({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    defaultLevel: 'standard',
    siteLevels: Object.freeze({}),
    pauses: Object.freeze({}),
    packs: Object.freeze({}),
    cookieBanners: 'leave',
    popups: Object.freeze({ mode: POPUP_GUARD_DEFAULT, sites: Object.freeze({}), notice: true }),
    gpc: false,
    onboarding: Object.freeze({ completedAt: null }),
    ui: Object.freeze({ theme: 'system', showBadge: true }),
  });
}
