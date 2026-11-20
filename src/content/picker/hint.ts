/**
 * The picker's side of the context-menu hint (P3-17 item 2). The hint comes from the worker inside
 * `x/pickerStart`, already validated there, and checked again by hand in `start.ts` (content scripts
 * import no npm packages). `findHinted` walks fixed element lists (`img`, `iframe`, …) and compares each one's
 * resolved `src` / `href` attribute with the hint URL: the hint is data to compare, never a selector.
 */
import type { PickHint, PickHintKind } from '../../core/picker/hint.js';
import { attributeOf, baseOf, queryAll } from './dom.js';

/** Fixed lists per kind (constants, never built from the hint) and the attribute compared. */
const LOOKUP: Readonly<Record<PickHintKind, { readonly selector: string; readonly attribute: 'src' | 'href' }>> = {
  image: { selector: 'img[src]', attribute: 'src' },
  video: { selector: 'video[src]', attribute: 'src' },
  audio: { selector: 'audio[src]', attribute: 'src' },
  frame: { selector: 'iframe[src],frame[src]', attribute: 'src' },
  link: { selector: 'a[href],area[href]', attribute: 'href' },
};

const resolved = (value: string | null, base: string): string | null => {
  if (value === null) return null;
  try {
    return new URL(value, base).href;
  } catch {
    // An attribute that is no URL matches nothing.
    return null;
  }
};

/** The first element of the hint's kind whose resolved URL equals the hint's, or `null`. */
export function findHinted(doc: Document, hint: PickHint): Element | null {
  const { selector, attribute } = LOOKUP[hint.kind];
  const base = baseOf(doc);
  return queryAll(doc, selector).find((el) => resolved(attributeOf(el, attribute), base) === hint.url) ?? null;
}
