/**
 * Routing of the settings pages' messages (P2-33…P2-37), registered in `messages.ts` with two lines:
 * which page may send each type (path on our origin; the origin itself is checked by the sender
 * policy), and the dispatch of the types handled here. `c/setSiteLevel` takes a hostname, not a tab
 * id, so the dashboard may send it too (design review 2026-11-14; the dashboard's Sites section resumes a pause
 * with it); `c/pauseSite` and `q/tabState` stay toolbar-panel only.
 */
import type { Hostname } from '../core/ids.js';
import type { MessageType, ParsedMessage, Response } from '../core/messaging/parse.js';
import { importBackup, previewBackup } from './backup.js';
import type { SettingsPageContext } from './backup.js';
import { completeOnboarding, dashboardState, forgetSites, setDefaultLevel, setShowBadge } from './settingsPages.js';

const DASHBOARD: ReadonlySet<string> = new Set(['/dashboard.html']);
const ONBOARDING: ReadonlySet<string> = new Set(['/onboarding.html']);
const SETTINGS_TABS: ReadonlySet<string> = new Set(['/dashboard.html', '/onboarding.html']);
const SITE_PAGES: ReadonlySet<string> = new Set(['/popup.html', '/dashboard.html']);
const LEVEL_PAGES: ReadonlySet<string> = new Set(['/popup.html', '/dashboard.html', '/onboarding.html']);

export const SETTINGS_PAGE_PAGES_OF: Readonly<Partial<Record<MessageType, ReadonlySet<string>>>> = {
  'q/dashboard': SETTINGS_TABS,
  'c/setDefaultLevel': LEVEL_PAGES,
  'c/forgetSites': DASHBOARD,
  'c/completeOnboarding': ONBOARDING,
  'c/setShowBadge': DASHBOARD,
  'q/previewBackup': DASHBOARD,
  'c/importBackup': DASHBOARD,
  'c/setSiteLevel': SITE_PAGES,
};

/** Handles the settings pages' own types; `null` for any other type. */
export function dispatchSettingsPage(message: ParsedMessage, ctx: SettingsPageContext): Promise<Response<unknown>> | null {
  switch (message.type) {
    case 'q/dashboard':
      return dashboardState(ctx);
    case 'c/forgetSites':
      return forgetSites(message.payload.hostnames as Hostname[], ctx);
    case 'q/previewBackup':
      return previewBackup(message.payload.json, ctx);
    case 'c/importBackup':
      return importBackup(message.payload.json, message.payload.expect, ctx);
    case 'c/completeOnboarding':
      return completeOnboarding(ctx);
    case 'c/setShowBadge':
      return setShowBadge(message.payload.enabled, ctx);
    case 'c/setDefaultLevel':
      return setDefaultLevel(message.payload.level, ctx);
    default:
      return null;
  }
}
