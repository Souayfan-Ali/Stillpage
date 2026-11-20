/**
 * Tabs adapter (P1-41): `tabs.get(tabId)` for the tab the toolbar panel names, nothing else. Without
 * the `tabs` permission Chrome fills `url` / `pendingUrl` only when the extension has host access to
 * the page, which is exactly the fact the panel needs. No tab events, no queries (ADR-001/007/012).
 */
import type { TabsApi } from './chromeApi.js';
import type { TabsPort } from './ports.js';

/** Chrome's rejection for a closed or unknown tab ("No tab with id: 12."). */
const NO_SUCH_TAB = 'No tab with id'; // i18n-exempt: Chrome's error text, matched

export function createTabsPort(api: TabsApi): TabsPort {
  return {
    get: async (tabId) => {
      try {
        const tab = await api.get(tabId);
        // A loading tab may report an empty `url` and the address it is going to in `pendingUrl`.
        const url = tab.url !== undefined && tab.url !== '' ? tab.url : (tab.pendingUrl ?? null);
        return { url: url === '' ? null : url };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(NO_SUCH_TAB)) return null;
        throw error;
      }
    },
  };
}
