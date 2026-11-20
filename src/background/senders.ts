/**
 * Sender checks shared by the user-feature handlers (P2-20, P2-21, P2-55; security reviews): which
 * page of ours sent a message, from which frame and tab. The envelope's sender policy runs first; these
 * bind a command to one exact page and frame.
 */
import type { SenderInfo } from '../core/messaging/sender.js';

/** The pathname when `sender` is a page of ours (id and origin), else `null`. */
export function ownPagePath(sender: SenderInfo, runtimeId: string): string | null {
  if (sender.id !== runtimeId || sender.url === undefined || !URL.canParse(sender.url)) return null;
  const url = new URL(sender.url);
  const isOwn = url.protocol === 'chrome-extension:' && url.host === runtimeId && (sender.origin === undefined || sender.origin === `chrome-extension://${runtimeId}`);
  return isOwn ? url.pathname : null;
}

/** The sender's tab id when it is an integer. */
export const senderTabId = (sender: SenderInfo): number | null => (Number.isInteger(sender.tab?.id) ? (sender.tab?.id ?? null) : null);

/** The picker panel: our page, framed (not a top-level document), in a tab. */
export function panelTab(sender: SenderInfo, runtimeId: string): number | null {
  const framed = sender.frameId !== undefined && sender.frameId !== 0;
  return ownPagePath(sender, runtimeId) === '/picker-panel.html' && framed ? senderTabId(sender) : null;
}

/**
 * The toolbar panel or the dashboard: our page, as a popup / the options page (no tab) or as the top
 * frame of a tab (P2-22; the panel too since P3-17: "open in a tab" and E2E, as the dashboard). Neither
 * page is web-accessible, so no web page can frame or open it; a framed copy never counts.
 */
export function isSettingsPage(sender: SenderInfo, runtimeId: string): boolean {
  const path = ownPagePath(sender, runtimeId);
  return (path === '/popup.html' || path === '/dashboard.html') && (sender.tab === undefined || sender.frameId === 0);
}
