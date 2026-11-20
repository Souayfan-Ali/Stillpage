/**
 * Ports for the user-facing features of the worker (P2-20 user filters, P2-21 picker start, P2-55
 * "Proceed once"): `storage.local` (the `uf:*` mirror only), injecting the on-demand picker, messaging
 * one tab's top frame, and the active tab. No tab events and no `tabs` permission (ADR-007/012).
 */
import { browser } from 'wxt/browser';

interface LocalStorePort {
  getAll(): Promise<Readonly<Record<string, unknown>>>;
  set(items: Readonly<Record<string, unknown>>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

export interface UserPorts {
  readonly local: LocalStorePort;
  /** `scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['picker.js'] })`, ISOLATED world. */
  readonly injectPicker: (tabId: number) => Promise<void>;
  /** `tabs.sendMessage(tabId, message, { frameId: 0 })`. */
  readonly sendToTopFrame: (tabId: number, message: unknown) => Promise<unknown>;
  /** The active tab of every normal browser window (`tabs.query`; ids need no `tabs` permission). */
  readonly activeTabIds: () => Promise<readonly number[]>;
}

export function createUserPorts(): UserPorts {
  return {
    local: {
      getAll: () => browser.storage.local.get(null),
      set: (items) => browser.storage.local.set({ ...items }),
      remove: (keys) => browser.storage.local.remove([...keys]),
    },
    injectPicker: async (tabId) => {
      await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['/picker.js'] });
    },
    sendToTopFrame: (tabId, message) => browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
    activeTabIds: async () => (await browser.tabs.query({ active: true, windowType: 'normal' })).flatMap((t) => (t.id === undefined ? [] : [t.id])),
  };
}
