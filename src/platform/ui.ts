/** The worker's toolbar badge option and first-run tab (P2-33, P2-36): `UiPort` over `chrome.*`. */
import { browser } from 'wxt/browser';
import type { UiPort } from './ports.js';

export function createUiPort(): UiPort {
  return {
    showActionCount: (enabled) => browser.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: enabled }),
    openOnboarding: async () => {
      await browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
    },
  };
}
