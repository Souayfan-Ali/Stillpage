/**
 * "Bigger area" / "Smaller area" (D-81, P3-17 item B): the picker owns a chain of elements from the pick
 * upwards. Widen goes to the nearest pickable ancestor whose box differs from the current one (same-box
 * wrappers are skipped), never to `body` or `html`, at most `MAX_WIDEN` steps above the pick; narrow goes
 * back down the same chain and never below the pick. Nothing is remembered between picks; the panel only
 * says "widen" / "narrow" and never names an element.
 */
import { parentOf, rectOf, tagNameOf } from './dom.js';
import { isPickable } from './traverse.js';

/** Most steps above the pick (D-81). */
export const MAX_WIDEN = 10;
/** A box covering at least this share of the viewport is "a large part of the page" (warning only). */
const LARGE_SHARE = 0.5;
const ROOTS: ReadonlySet<string> = new Set(['BODY', 'HTML']);

interface Box { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

export interface AreaChain {
  readonly at: () => Element;
  readonly widen: () => boolean;
  readonly narrow: () => boolean;
  readonly canWiden: () => boolean;
  readonly canNarrow: () => boolean;
}

export interface AreaDeps {
  /** Defaults to the native `getBoundingClientRect`; tests stand in for layout. */
  readonly rect?: (el: Element) => Box;
}

const sameBox = (a: Box, b: Box): boolean => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
const hasBox = (b: Box): boolean => b.width > 0 && b.height > 0;

/** The nearest ancestor of `el` worth offering, or `null` at `body`. */
function nextUp(el: Element, rect: (el: Element) => Box): Element | null {
  const from = rect(el);
  for (let p = parentOf(el); p !== null && !ROOTS.has(tagNameOf(p).toUpperCase()); p = parentOf(p)) {
    const box = rect(p);
    if (isPickable(p, () => !hasBox(box)) && !sameBox(box, from)) return p;
  }
  return null;
}

/** The chain for one pick. */
export function createAreaChain(pick: Element, deps: AreaDeps = {}): AreaChain {
  const rect = deps.rect ?? rectOf;
  let chain: readonly Element[] = [pick];
  let level = 0;
  const above = (): Element | null => chain[level + 1] ?? (level < MAX_WIDEN ? nextUp(chain[level] ?? pick, rect) : null);
  return {
    at: () => chain[level] ?? pick,
    canWiden: () => level < MAX_WIDEN && above() !== null,
    canNarrow: () => level > 0,
    widen: () => {
      const next = level < MAX_WIDEN ? above() : null;
      if (next === null) return false;
      if (chain[level + 1] === undefined) chain = [...chain, next];
      level += 1;
      return true;
    },
    narrow: () => {
      if (level === 0) return false;
      level -= 1;
      return true;
    },
  };
}

/** True when the visible part of `box` covers at least half of `viewport`. */
export function isLarge(box: Box, viewport: { readonly width: number; readonly height: number }): boolean {
  const width = Math.max(0, Math.min(box.left + box.width, viewport.width) - Math.max(box.left, 0));
  const height = Math.max(0, Math.min(box.top + box.height, viewport.height) - Math.max(box.top, 0));
  return width * height >= LARGE_SHARE * viewport.width * viewport.height;
}
