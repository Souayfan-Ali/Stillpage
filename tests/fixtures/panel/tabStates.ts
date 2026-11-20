/**
 * One `q/tabState` answer per header state of UI notes §3 (P1-40), used by the component tests and
 * by the panel E2E (which answers the panel's query with these). "Panel" = our toolbar panel; the
 * `popups*` fixture families are pop-up windows (UI notes §2), a different thing.
 */
import type { TabState } from '../../../src/core/messaging/tabState.js';
import type { HeaderKind } from '../../../src/features/popup/header.js';

/** Fixed clock for the paused state: 24 minutes and a few seconds before the pause ends. */
export const NOW = 1_800_000_000_000;
const PAUSE_LEFT_MS = 23 * 60_000 + 30_000;

const BASE: TabState = {
  page: 'web',
  host: 'news.example.com',
  level: 'standard',
  setOn: null,
  pausedUntil: null,
  access: 'all',
  ready: true,
  settingsReset: false,
  theme: 'system',
  lastRun: 'ok',
  site: { ownLevel: null, popupPolicy: null, pausedUntil: null },
  packs: ['ads', 'trackers'],
  popupMode: 'off',
  popupGuard: false,
  hidden: [],
};

export const TAB_STATES: Readonly<Record<HeaderKind, TabState>> = {
  normal: BASE,
  off: { ...BASE, level: 'off', setOn: 'news.example.com' },
  paused: { ...BASE, level: 'off', setOn: 'news.example.com', pausedUntil: NOW + PAUSE_LEFT_MS },
  reduced: { ...BASE, access: 'none' },
  limited: { ...BASE, access: 'site' },
  restricted: { ...BASE, page: 'restricted', host: null },
  admin: { ...BASE, page: 'admin' },
  setup: { ...BASE, ready: false },
  reset: { ...BASE, settingsReset: true },
};

/** Expected text of each state (UI notes §3 table). */
export const HEADER_TEXT: Readonly<Record<HeaderKind, string>> = {
  normal: 'Protected — Standard',
  off: 'Off on this site',
  paused: 'Paused for 24 more minutes',
  reduced: 'Running as Light: site access is off',
  limited: 'Protected — Standard. Replacement scripts and the pop-up blocked page need access to all sites',
  restricted: 'Chrome does not allow extensions on this page',
  admin: 'Your organisation limits extensions on this site',
  setup: 'Setting up… (a few seconds)',
  reset: 'Your settings were reset because they could not be read',
};

const PAUSE = 'Pause on this site';

/** Buttons each state draws (UI notes §3; "Restore a backup" arrives with backups, P2-37). */
export const HEADER_BUTTONS: Readonly<Record<HeaderKind, readonly string[]>> = {
  normal: [PAUSE],
  off: ['Turn back on'],
  paused: ['Resume now'],
  reduced: ['Allow on this site', 'Allow on all sites', PAUSE],
  limited: ['Allow on all sites', PAUSE],
  restricted: [],
  admin: [],
  setup: [],
  reset: ['Dismiss', PAUSE],
};
