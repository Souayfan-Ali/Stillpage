/**
 * Install-time work outside the reconcile plan (P2-33, P2-36, design review 2026-11-14): on a fresh install the
 * worker opens the first-run tab (every profile, also automated ones: D-46); Chrome's blocked-request
 * count on the toolbar icon follows `ui.showBadge`. Chrome keeps that option across sessions, so it is
 * set on install and update and again only when the setting changes. A failure is logged, never thrown.
 */
import type { Ports } from '../platform/ports.js';
import type { SettingsStore } from './settingsStore.js';

/** Shows or hides the action count; a missing UI port (tests, fakes) does nothing. */
export async function applyBadge(ports: Ports, enabled: boolean): Promise<void> {
  try {
    await ports.ui?.showActionCount(enabled);
  } catch (error) {
    ports.log.error('could not set the badge option', error);
  }
}

/** `runtime.onInstalled`: the first-run tab on `install` only; the badge option on every install or update. */
export async function onInstalled(reason: string, ports: Ports, store: SettingsStore): Promise<void> {
  try {
    if (reason === 'install') await ports.ui?.openOnboarding();
  } catch (error) {
    ports.log.error('could not open the onboarding tab', error);
  }
  const loaded = await store.read(ports.now()).catch((error: unknown) => {
    ports.log.warn('settings unreadable on install; badge setting not applied', error);
    return null;
  });
  if (loaded !== null && !loaded.isUnreadable) await applyBadge(ports, loaded.settings.ui.showBadge);
}
