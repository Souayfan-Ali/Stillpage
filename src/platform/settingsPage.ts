/**
 * Extension-page adapter of the dashboard and the onboarding page (P2-33…P2-38): the few `chrome.*`
 * calls those pages make themselves. They reach the worker only by `runtime.sendMessage` with the
 * P1-12 envelope (built by the caller) and ask for site access inside the click (architecture notes §8).
 */
import { browser } from 'wxt/browser';

export interface SettingsPagePort {
  /** Sends one envelope to the worker and resolves with its raw (unvalidated) answer. */
  send(envelope: unknown): Promise<unknown>;
  /** Asks Chrome for site access to `origins`; must run inside a user gesture. */
  requestOrigins(origins: readonly string[]): Promise<boolean>;
  /** The browser's UI language, for the regional pack suggestion (computed locally, P2-29). */
  uiLanguage(): string;
  /** This build's version (`runtime.getManifest().version`). */
  version(): string;
}

export function createSettingsPagePort(): SettingsPagePort {
  return {
    send: (envelope) => browser.runtime.sendMessage(envelope),
    requestOrigins: (origins) => browser.permissions.request({ origins: [...origins] }),
    uiLanguage: () => browser.i18n.getUILanguage(),
    version: () => browser.runtime.getManifest().version,
  };
}
