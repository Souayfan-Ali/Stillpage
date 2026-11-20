// Toolbar panel entry (P1-40): mounts the feature and wires the page port. The shell renders
// synchronously; the first chrome.* call happens after it, inside `store.load()` (S-06).
import '../../ui/tokens.css';
import { render } from 'preact';
import { PRODUCT_NAME } from '../../core/brand.js';
import { createClient } from '../../features/popup/client.js';
import { PopupApp } from '../../features/popup/PopupApp.js';
import { createPopupStore } from '../../features/popup/store.js';
import { createPrivacyStore } from '../../features/popup/privacy/privacyStore.js';
import { applyTheme, tabIdFromSearch } from '../../features/popup/page.js';
import { createPagePort } from '../../platform/page.js';
import { applyDocumentLocale } from '../../ui/i18n.js';
import { ISSUE_TRACKER_URL, trackerOf } from '../../core/tracker.js';
import { readPopupLog, type PopupLog } from '../../core/popup/log.js';

const root = document.getElementById('app');
if (root !== null) {
  document.title = PRODUCT_NAME;
  applyDocumentLocale(document);
  const page = createPagePort();
  const client = createClient(page);
  const popupLog = (tabId: number): Promise<PopupLog | null> => page.popupLog(tabId).then(readPopupLog);
  const privacy = createPrivacyStore({ client, copyText: (text) => page.copyText(text), popupLog });
  const store = createPopupStore({
    client,
    page,
    tabIdFromUrl: tabIdFromSearch(location.search),
  });
  root.replaceChildren();
  render(
    <PopupApp
      store={store}
      now={() => Date.now()}
      version={page.version()}
      privacy={privacy}
      popupRow={{ client, popupLog, openTab: (url) => page.openTab(url) }}
      hidden={{
        inject: (tabId, func, args) => page.inject(tabId, func, args),
        remove: (hostname, selector) => client.command('c/removeUserFilter', { hostname, selector }).then((r) => r.ok),
      }}
      breakage={{
        client,
        session: page.session,
        reloadTab: (tabId) => page.reloadTab(tabId),
        now: () => Date.now(),
        report: {
          client,
          copyText: (text) => page.copyText(text),
          openTab: (url) => page.openTab(url),
          version: page.version(),
          chromeMajor: page.chromeMajor(),
          incognito: page.incognito(),
          tracker: trackerOf(ISSUE_TRACKER_URL),
          popupLog,
        },
      }}
      applyTheme={(theme) => {
        applyTheme(document.documentElement, theme);
      }}
    />,
    root,
  );
  void store.load();
}
