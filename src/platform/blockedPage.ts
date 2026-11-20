/**
 * The `chrome.*` calls of the blocked page (P2-55, pop-up notes §6.2): its own tab and opener (no `tabs`
 * permission needed: `id` and `openerTabId` are not privileged, S-19), the opener sentinel's link-click
 * answer, closing itself, and `c/proceedOnce`. New file, behind the platform boundary.
 */
import { browser } from 'wxt/browser';
import { LINK_CHECK_TIMEOUT_MS } from '../core/popup/constants.js';
import { parseLiftedList } from '../core/reconcile/popupLists.js';

export interface BlockedPagePort {
  readonly currentTab: () => Promise<{ readonly id: number; readonly openerTabId?: number } | null>;
  readonly askOpener: (openerTabId: number, host: string) => Promise<{ readonly scriptOpened: boolean; readonly linkClick: boolean }>;
  readonly closeTab: (tabId: number) => Promise<void>;
  readonly proceed: (host: string) => Promise<boolean>;
  /** Tells the opener's sentinel (if the guard runs there) to show "Pop-up blocked" (P2-57). */
  readonly notifyOpener: (openerTabId: number, host: string) => Promise<void>;
  /**
   * Whether `host` is in our own packaged `popup-lifted.json` (D-55a). Read from the package, not the
   * network; it ignores which packs are on, so it may show the address when the worker grants the
   * host-wide Proceed once instead: the line then still says only where the page goes (security review LOW).
   */
  readonly isLifted: (host: string) => Promise<boolean>;
}

const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => { setTimeout(() => { resolve(value); }, ms); });
const isOk = (r: unknown): boolean => typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === true;

export function blockedPagePort(): BlockedPagePort {
  return {
    currentTab: async () => {
      const tab = await browser.tabs.getCurrent();
      if (tab?.id === undefined) return null;
      return tab.openerTabId === undefined ? { id: tab.id } : { id: tab.id, openerTabId: tab.openerTabId };
    },
    // The sentinel answers exactly `true` (P2-57, P2-58); no sentinel (guard off), an error or no answer in
    // `LINK_CHECK_TIMEOUT_MS` is "no". A one-shot opened-check is asked first, the link check beside it.
    askOpener: async (openerTabId, host) => {
      const ask = (type: string): Promise<boolean> => Promise.race([
        browser.tabs.sendMessage(openerTabId, { type, host }, { frameId: 0 }).then((answer: unknown) => answer === true, () => false),
        after(LINK_CHECK_TIMEOUT_MS, false),
      ]);
      const [scriptOpened, linkClick] = await Promise.all([ask('x/openedCheck'), ask('x/linkClickCheck')]);
      return { scriptOpened, linkClick };
    },
    closeTab: (tabId) => browser.tabs.remove(tabId),
    notifyOpener: async (openerTabId, host) => {
      await browser.tabs.sendMessage(openerTabId, { type: 'x/popupClosed', host }, { frameId: 0 }).catch(() => undefined);
    },
    isLifted: async (host) => {
      const lists = parseLiftedList(await (await fetch(browser.runtime.getURL('/popup-lifted.json'))).text());
      return lists !== null && Object.values(lists).some((hosts) => (hosts as readonly string[]).includes(host));
    },
    proceed: async (host) => isOk(await browser.runtime.sendMessage({ v: 1, type: 'c/proceedOnce', id: 'blocked', payload: { hostname: host } })),
  };
}
