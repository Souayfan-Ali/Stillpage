// Blocked page entry (P2-55): no framework; wires `runBlockedPage` to the tab, history and the worker.
import '../../ui/tokens.css';
import './blocked.css';
import { isRealClick, renderFallback, runBlockedPage } from '../../features/blocked-page/page.js';
import { blockedPagePort } from '../../platform/blockedPage.js';
import { applyDocumentLocale, t } from '../../ui/i18n.js';

applyDocumentLocale(document);
document.title = t('blocked_title');

const goBack = (): void => { history.back(); };
runBlockedPage({
  ...blockedPagePort(),
  document,
  hash: location.hash,
  referrer: document.referrer,
  historyLength: history.length,
  goBack,
  navigate: (url) => { location.replace(url); },
  framed: window.top !== window,
  userActive: (click) => isRealClick(click, navigator.userActivation.isActive),
  // The page has no logger: a failed run still leaves the user a way back. A framed copy (a hostile page
  // embedding it) draws nothing on purpose.
}).catch(() => { if (window.top === window) renderFallback({ document, goBack }); });
