/**
 * DOM signals of the pop-up guard (P2-57, pop-up notes §7.2, §7.4), read once per trusted gesture: is the
 * clicked element interactive, is it a hijack overlay, and which link (if any) it sits in. No observers,
 * no work on `mousemove` or scroll; the cost is paid per click.
 */
import { LARGE_TARGET_RATIO, OVERLAY_EDGE_TOLERANCE, OVERLAY_MAX_ALPHA } from '../../core/popup/constants.js';

const INTERACTIVE = 'a[href],button,input,select,summary,label,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[onclick],[tabindex]:not([tabindex="-1"]),video[controls],audio[controls]';
const MEDIA = 'img,video,canvas,svg,iframe';
/** How far up an interactive ancestor may be (pop-up notes §7.2). */
const ANCESTOR_DEPTH = 5;
/** `z-index` that makes a positioned ancestor count as a stacking layer (pop-up notes §7.4). */
const OVERLAY_Z = 1000;

export interface View {
  readonly innerWidth: number;
  readonly innerHeight: number;
  getComputedStyle(el: Element): CSSStyleDeclaration;
}

const area = (r: DOMRect): number => Math.max(0, r.width) * Math.max(0, r.height);

/** `el` or an ancestor within 5 levels is a control or has `cursor:pointer`, and it is not huge. */
export function isInteractive(el: Element, view: View): boolean {
  const viewport = view.innerWidth * view.innerHeight;
  let n: Element | null = el;
  for (let depth = 0; n !== null && depth <= ANCESTOR_DEPTH; depth += 1, n = n.parentElement) {
    if (n.matches(INTERACTIVE) || view.getComputedStyle(n).cursor === 'pointer') return area(n.getBoundingClientRect()) < LARGE_TARGET_RATIO * viewport;
  }
  return false;
}

/** Alpha of a computed colour (`rgba(r, g, b, a)`), 1 for `rgb(…)`. */
const alphaOf = (color: string): number => Number(/,\s*([\d.]+)\)$/.exec(color.replace(/^rgb\(/, '('))?.[1] ?? 1);

function raised(el: Element, view: View): boolean {
  if (view.getComputedStyle(el).position !== 'static') return true;
  for (let n = el.parentElement, depth = 0; n !== null && depth < ANCESTOR_DEPTH; n = n.parentElement, depth += 1) {
    const s = view.getComputedStyle(n);
    if (s.position !== 'static' && Number(s.zIndex) >= OVERLAY_Z) return true;
  }
  return false;
}

/** A transparent, empty, positioned box over the whole viewport (pop-up notes §7.4). */
export function isHijackOverlay(el: Element, view: View): boolean {
  const r = el.getBoundingClientRect();
  const [w, h, tol] = [view.innerWidth, view.innerHeight, OVERLAY_EDGE_TOLERANCE];
  const covers = r.left <= w * tol && r.top <= h * tol && r.right >= w * (1 - tol) && r.bottom >= h * (1 - tol);
  if (!covers || !raised(el, view)) return false;
  if (el.textContent.trim() !== '' || el.querySelector(MEDIA) !== null) return false;
  const s = view.getComputedStyle(el);
  const clear = Number(s.opacity) <= OVERLAY_MAX_ALPHA || alphaOf(s.backgroundColor) <= OVERLAY_MAX_ALPHA;
  return clear && s.backgroundImage === 'none';
}

/**
 * True for an element node, from any realm (the page's, a frame's or ours). `nodeType` is read through
 * `Node.prototype`: a page's `<form><input name=nodeType>` shadows it on the form (P2-43 security review).
 */
export function isElement(x: unknown): x is Element {
  try {
    return typeof x === 'object' && x !== null && Reflect.apply(Reflect.get(Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType') ?? {}, 'get') as () => unknown, x, []) === 1;
  } catch {
    return false; // not a node at all
  }
}

/** The nearest link around `el` with a real address, and whether it is visible. */
export function linkOf(el: Element, view: View): { readonly anchor: HTMLAnchorElement; readonly href: string; readonly visible: boolean } | null {
  // Through `Element.prototype` of the element's realm (ours when the page shadowed the way there), not
  // `el.closest`: a clicked `<form>` can shadow it (P2-43 security review).
  const realm = (el as { readonly ownerDocument?: { readonly defaultView?: { readonly Element?: typeof Element } } }).ownerDocument?.defaultView?.Element ?? Element;
  const found = realm.prototype.closest.call(el, 'a[href]');
  if (found?.tagName !== 'A' || /^\s*(#|javascript:)/i.test(found.getAttribute('href') ?? '')) return null;
  const anchor = found as HTMLAnchorElement;
  const s = view.getComputedStyle(anchor);
  const visible = area(anchor.getBoundingClientRect()) > 0 && s.visibility !== 'hidden' && Number(s.opacity) > OVERLAY_MAX_ALPHA;
  return { anchor, href: anchor.href, visible };
}
