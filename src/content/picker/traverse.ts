/**
 * Keyboard traversal of the picker overlay (P2-18, UI notes §5): up = parent, down = first child,
 * left / right = previous / next sibling. Our own host element, elements without a box (`script`,
 * `style`, zero-size or not rendered, judged by the caller's `skip`) are skipped; the selection never
 * goes above `body`, and at an edge it stays where it is.
 */

import { childrenOf, nextSiblingOf, parentOf, previousSiblingOf, tagNameOf } from './dom.js';

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

const NOT_VISUAL: ReadonlySet<string> = new Set(['HTML', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BASE']);

/** True for an element the user can pick; `skip` rejects our host and elements without a box. */
export const isPickable = (el: Element, skip: (e: Element) => boolean): boolean => !NOT_VISUAL.has(tagNameOf(el).toUpperCase()) && !skip(el);

function sibling(el: Element, forward: boolean, skip: (e: Element) => boolean): Element | null {
  for (let s = forward ? nextSiblingOf(el) : previousSiblingOf(el); s !== null; s = forward ? nextSiblingOf(s) : previousSiblingOf(s)) {
    if (isPickable(s, skip)) return s;
  }
  return null;
}

function firstChild(el: Element, skip: (e: Element) => boolean): Element | null {
  return childrenOf(el).find((c) => isPickable(c, skip)) ?? null;
}

/** The element `key` moves to from `el`, or `el` itself at an edge. */
export function step(el: Element, key: NavKey, skip: (e: Element) => boolean): Element {
  switch (key) {
    case 'ArrowUp': {
      const parent = tagNameOf(el).toUpperCase() === 'BODY' ? null : parentOf(el);
      return parent !== null && isPickable(parent, skip) ? parent : el;
    }
    case 'ArrowDown':
      return firstChild(el, skip) ?? el;
    case 'ArrowLeft':
      return sibling(el, false, skip) ?? el;
    case 'ArrowRight':
      return sibling(el, true, skip) ?? el;
  }
}
