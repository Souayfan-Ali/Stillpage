/**
 * Sender policy (P1-12, ADR-012 item 5, architecture notes §7): authority comes from `sender`, which Chrome fills
 * in the browser process, never from the payload. A compromised renderer can act as our content
 * script but cannot claim the extension origin, so only extension pages may issue commands.
 */

/** The fields of `chrome.runtime.MessageSender` the policy reads (plain data; core has no chrome types). */
export interface SenderInfo {
  readonly id?: string | undefined;
  readonly url?: string | undefined;
  readonly origin?: string | undefined;
  readonly tab?: { readonly id?: number | undefined } | undefined;
  readonly frameId?: number | undefined;
}

export type SenderKind = 'extension-page' | 'content-script' | 'foreign';

/** Parses `url`; `null` when it is not a URL. */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * `extension-page`: our id, and the document URL (and origin, when Chrome reports it) is our own
 * extension origin — popup, dashboard, onboarding, picker panel, `blocked.html`.
 * `content-script`: our id in a tab whose document is not ours. Anything else is `foreign`.
 * The origin is compared as a string: `URL.origin` is `"null"` for `chrome-extension:` in some runtimes.
 */
export function classifySender(sender: SenderInfo, runtimeId: string): SenderKind {
  if (sender.id !== runtimeId || sender.url === undefined) return 'foreign';
  const url = parseUrl(sender.url);
  if (url === null) return 'foreign';
  const own = `chrome-extension://${runtimeId}`;
  if (url.protocol === 'chrome-extension:') {
    const isOwn = url.host === runtimeId && (sender.origin === undefined || sender.origin === own);
    return isOwn ? 'extension-page' : 'foreign';
  }
  return sender.tab?.id === undefined ? 'foreign' : 'content-script';
}

/** True when the sender is our packaged `blocked.html` as a tab's top-level document (the only `c/proceedOnce` source). */
export function isBlockedPage(sender: SenderInfo, runtimeId: string): boolean {
  if (classifySender(sender, runtimeId) !== 'extension-page' || sender.url === undefined) return false;
  return new URL(sender.url).pathname === '/blocked.html' && Number.isInteger(sender.tab?.id) && sender.frameId === 0;
}
