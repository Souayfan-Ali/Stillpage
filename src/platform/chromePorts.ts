/**
 * Wires the real adapters to `chrome.*` (P1-10). Together with `events.ts` this is the only code
 * that touches the browser namespace; a unit test checks that nothing outside `src/platform/`
 * does. The casts are the one place Chrome's enum-typed declarations meet our string unions.
 */
import { browser } from 'wxt/browser';
import type { DnrApi, ScriptingApi, TabsApi } from './chromeApi.js';
import { createCatalogPort, createPackagePort, fetchPackagedJson, packagedFiles } from './catalog.js';
import { createDnrPort } from './dnr.js';
import { createLogger } from './log.js';
import type { Ports } from './ports.js';
import { createScriptingPort } from './scripting.js';
import { createAlarmsPort, createPermissionsPort, createSessionStorePort } from './simple.js';
import { createTabsPort } from './tabs.js';
import { createUiPort } from './ui.js';
import { createUserPorts } from './userPorts.js';
import { createVaultPort } from './vault.js';

/** Our extension id (for the sender policy). */
export function runtimeId(): string {
  return browser.runtime.id;
}

export function createChromePorts(): Ports {
  return {
    dnr: createDnrPort(browser.declarativeNetRequest as unknown as DnrApi),
    scripting: createScriptingPort(browser.scripting as unknown as ScriptingApi),
    session: createSessionStorePort(browser.storage.session),
    permissions: createPermissionsPort(browser.permissions),
    alarms: createAlarmsPort(browser.alarms),
    vault: createVaultPort(indexedDB),
    catalog: createCatalogPort(browser.runtime, fetchPackagedJson, packagedFiles),
    package: createPackagePort(browser.runtime, packagedFiles),
    tabs: createTabsPort(browser.tabs as unknown as TabsApi),
    user: createUserPorts(),
    log: createLogger(import.meta.env.DEV),
    now: () => Date.now(),
    ui: createUiPort(),
  };
}
