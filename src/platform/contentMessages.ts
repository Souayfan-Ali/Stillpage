/**
 * The one message a content script may send (security notes §5, P1-38): `cs/cssFallback`, naming a shard
 * registration and nothing else — never selector text. Fire and forget; the worker answers nothing
 * the page could use. Used only from frames without `adoptedStyleSheets`.
 */
import { extensionApi } from './contentApi.js';

export function sendCssFallback(registration: string): void {
  // Quiet by design: no worker answer (updating, or the frame went away) leaves the frame un-hidden.
  extensionApi().runtime.sendMessage({ v: 1, type: 'cs/cssFallback', id: 'cs', payload: { registration } }).catch(() => undefined);
}
