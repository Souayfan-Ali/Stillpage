/**
 * The context-menu pick hint (P3-17 item 2): what was right-clicked, reduced to one kind and one URL.
 * The worker derives it from `contextMenus.OnClickData` (Valibot, `background/pickerHint.ts`) and sends
 * it inside `x/pickerStart`; the picker checks it again (`content/picker/hint.ts`) and only compares it
 * with element attributes. It never becomes a selector or code. Pure.
 */

export const PICK_HINT_KINDS = ['image', 'video', 'audio', 'frame', 'link'] as const;
export type PickHintKind = (typeof PICK_HINT_KINDS)[number];

export interface PickHint {
  readonly kind: PickHintKind;
  readonly url: string;
}

/** Longest hint URL (longer ones are dropped: the picker starts as before). */
const MAX_HINT_URL = 2048;

/** True for an http(s) URL of at most `MAX_HINT_URL` characters that parses. */
export function isHintUrl(x: unknown): x is string {
  return typeof x === 'string' && x.length <= MAX_HINT_URL && /^https?:\/\//.test(x) && URL.canParse(x);
}
