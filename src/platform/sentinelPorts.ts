/**
 * The pop-up sentinel's one listener (P2-57): `x/popupLog`, `x/linkClickCheck`, `x/popupClosed`, answered
 * only for our own extension's pages (the toolbar panel, `blocked.html`), never for a page or another
 * extension. Read-only answers; nothing is stored.
 */
import { extensionApi } from './contentApi.js';
import type { NoticeKey } from '../content/popup-sentinel/strings.js';

export function onExtensionQuery(answer: (message: unknown) => unknown): void {
  const { runtime } = extensionApi();
  const own = `chrome-extension://${runtime.id}/`;
  runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== runtime.id || sender.url?.startsWith(own) !== true) return undefined;
    const reply = answer(message);
    if (reply === undefined) return undefined;
    sendResponse(reply);
    return undefined;
  });
}

/** Opens `url` in a new tab with no opener, from a user's click on the notice. */
export function openFromNotice(url: string): void {
  window.open(url, '_blank', 'noopener');
}

/**
 * The in-page notice's words from `_locales` (P2-40). WXT types `getMessage` with the keys of its own
 * `public/_locales` only; ours live at the root, so the key is passed through untyped here.
 */
export const noticeText = (key: NoticeKey): string => (extensionApi().i18n.getMessage as (name: string) => string)(key);
