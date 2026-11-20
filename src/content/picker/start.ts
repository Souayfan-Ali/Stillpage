/**
 * The picker's start message (P2-18; design review): after injecting `picker.js` the worker sends
 * `tabs.sendMessage(tabId, { type: 'x/pickerStart', nonce, mode, hint? }, { frameId: 0 })`. It is accepted
 * only from our own extension and only from a non-tab context (the worker), and validated in full.
 * Defined content-side for now; the shared envelope schema gains it with the worker handler (P2-20).
 */

import { isHintUrl, PICK_HINT_KINDS, type PickHint, type PickHintKind } from '../../core/picker/hint.js';

export const PICKER_START = 'x/pickerStart';
/** Same pattern as the envelope's `nonce` (`core/messaging/schemas.ts`). */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const KEYS = ['mode', 'nonce', 'type'].join();
/** With the context-menu hint (P3-17). */
const KEYS_WITH_HINT = ['hint', 'mode', 'nonce', 'type'].join();

export interface PickerStart {
  readonly nonce: string;
  readonly mode: 'zap' | 'hide';
  /** The right-clicked element (P3-17); `null` when absent or malformed (the picker starts as before). */
  readonly hint: PickHint | null;
}

/** The fields of `chrome.runtime.MessageSender` that matter here. */
export interface StartSender {
  readonly id?: string;
  readonly tab?: unknown;
}

const isKind = (x: unknown): x is PickHintKind => (PICK_HINT_KINDS as readonly unknown[]).includes(x);

/** The context-menu hint (P3-17), checked again by hand, or `null` when anything in it is off. */
export function parsePickHint(x: unknown): PickHint | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  if (Object.keys(x).sort().join() !== 'kind,url') return null;
  const { kind, url } = x as Readonly<Record<string, unknown>>;
  return isKind(kind) && isHintUrl(url) ? { kind, url } : null;
}

/** The start request, or `null` when the message or its sender is not the worker's start. */
export function acceptStart(message: unknown, sender: StartSender, ownId: string): PickerStart | null {
  if (sender.id !== ownId || sender.tab !== undefined) return null;
  if (typeof message !== 'object' || message === null) return null;
  const m = message as Readonly<Record<string, unknown>>;
  const keys = Object.keys(m).sort().join();
  if ((keys !== KEYS && keys !== KEYS_WITH_HINT) || m['type'] !== PICKER_START) return null;
  const { nonce, mode } = m;
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce) || (mode !== 'zap' && mode !== 'hide')) return null;
  return { nonce, mode, hint: parsePickHint(m['hint']) };
}
