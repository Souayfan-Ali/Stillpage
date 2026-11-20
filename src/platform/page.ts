/**
 * Extension-page adapter (P1-40): the `chrome.*` calls the toolbar panel makes itself. It talks
 * to the worker only by `runtime.sendMessage` with the P1-12 envelope (built by the caller); it asks
 * for site access from the page, inside the click, as `permissions.request` requires (architecture notes §8).
 * New file; nothing else in `src/platform` changes.
 */
import { browser } from 'wxt/browser';

export interface PagePort {
  /** Sends one envelope to the worker and resolves with its raw (unvalidated) answer. */
  send(envelope: unknown): Promise<unknown>;
  /** The active tab of the window the panel belongs to, or `null`. */
  activeTabId(): Promise<number | null>;
  /** Asks Chrome for site access to `origins`; must run inside a user gesture. */
  requestOrigins(origins: readonly string[]): Promise<boolean>;
  /** Reloads one tab (`tabs.reload` needs no `tabs` permission). */
  reloadTab(tabId: number): Promise<void>;
  /** This build's version (`runtime.getManifest().version`), for the rules date. */
  version(): string;
  /** Writes text to the clipboard ("Copy summary", "Copy report"); call inside the click. */
  copyText(text: string): Promise<void>;
  /** Opens `url` in a new tab (`tabs.create` needs no permission): the prefilled new-issue page (P2-15). */
  openTab(url: string): Promise<void>;
  /** This page runs in a private window (split incognito). */
  incognito(): boolean;
  /** Chrome's major version from the user agent, or `null`. */
  chromeMajor(): number | null;
  /**
   * The page's pop-up log from its sentinel (`x/popupLog`, top frame only), raw; `null` when the page
   * has no sentinel (guard not on there) or does not answer. The caller validates it (`readPopupLog`).
   */
  popupLog(tabId: number): Promise<unknown>;
  /**
   * Runs a packaged function in the tab's top frame (`scripting.executeScript` with `func` and JSON `args`,
   * never code built from data) and resolves with its raw answer (P2-22b "Show on page"). Host access or
   * the toolbar click's `activeTab` grant covers it.
   */
  inject<A extends unknown[]>(tabId: number, func: (...args: A) => unknown, args: A): Promise<unknown>;
  /** The browser's UI languages for the regional pack suggestion (P2-29: `[chrome.i18n.getUILanguage()]`). */
  uiLanguages(): readonly string[];
  /** `storage.session` (trusted contexts only): the breakage flow's state per tab (P2-14). */
  readonly session: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
}

export function createPagePort(): PagePort {
  return {
    send: (envelope) => browser.runtime.sendMessage(envelope),
    activeTabId: async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      return tab?.id ?? null;
    },
    requestOrigins: (origins) => browser.permissions.request({ origins: [...origins] }),
    reloadTab: (tabId) => browser.tabs.reload(tabId),
    version: () => browser.runtime.getManifest().version,
    copyText: (text) => navigator.clipboard.writeText(text),
    openTab: async (url) => {
      await browser.tabs.create({ url });
    },
    incognito: () => browser.extension.inIncognitoContext,
    inject: async (tabId, func, args) => {
      const [first] = await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, func, args });
      return first?.result;
    },
    uiLanguages: () => [browser.i18n.getUILanguage()],
    popupLog: (tabId) => browser.tabs.sendMessage(tabId, { type: 'x/popupLog' }, { frameId: 0 }).then((answer: unknown) => answer ?? null, () => null),
    chromeMajor: () => {
      const major = /Chrome\/(\d{2,4})\./.exec(navigator.userAgent)?.[1];
      return major === undefined ? null : Number(major);
    },
    session: {
      get: async (key) => (await browser.storage.session.get(key))[key],
      set: (key, value) => browser.storage.session.set({ [key]: value }),
      remove: (key) => browser.storage.session.remove(key),
    },
  };
}
