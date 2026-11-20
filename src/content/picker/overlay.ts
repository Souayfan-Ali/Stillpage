/**
 * Picker overlay (P2-18, cosmetic notes §9, UI notes §5; decisions: design review, P2-18 notes). A **closed** shadow
 * root on a host element with no id or class holds a full-viewport capture layer (it takes the
 * pointer, so the page sees no hover and no click), the highlight box with a visible label, a focus
 * target, a live region and a visible hint pill while choosing (D-104, aria-hidden). Hit-testing uses `elementsFromPoint`, skipping our host. Only trusted
 * events act; keys are taken in a window capture listener and never reach the page. Arrows move
 * (`traverse.ts`), Enter picks, Escape cancels. Nothing is written to the page's globals (ISOLATED
 * world); styles are CSSOM properties and a constructed sheet, so a strict page CSP does not break it.
 */
import { describeElement } from './describe.js';
import { activeOf, bodyOf, createElementIn, isConnected, queryAll, queryOne, rectOf, rootOf } from './dom.js';
import { isPickable, step, type NavKey } from './traverse.js';

export interface OverlayEnv {
  readonly document: Document;
  readonly window: Window;
  /** `document.elementsFromPoint`, topmost first. */
  readonly elementsFromPoint: (x: number, y: number) => readonly Element[];
  readonly onPick: (el: Element) => void;
  readonly onCancel: () => void;
  /** Accessible name of the keyboard focus target, from `_locales` (P2-40; read by the entry script). */
  readonly label: string;
  /** The visible hint pill's text while choosing (D-104), from `_locales`. */
  readonly hint: string;
  /** Defaults to `event.isTrusted`; tests stand in for a real user. */
  readonly isTrusted?: (e: Event) => boolean;
  /** Defaults to "has a box": zero-size and non-rendered elements are skipped. */
  readonly hasBox?: (el: Element) => boolean;
}

export interface Overlay {
  readonly current: () => Element | null;
  /** Picks `el` as a click would, if it is pickable (the right-clicked element, P3-17); false otherwise. */
  readonly pickNow: (el: Element) => boolean;
  /** Moves the highlight to `el` without picking (D-81: the area chosen in the panel). */
  readonly mark: (el: Element) => void;
  readonly announcement: () => string;
  /** Back to choosing (after the panel is closed without saving). */
  readonly resume: () => void;
  /** Places the panel iframe inside the closed root. */
  readonly mount: (node: Element) => void;
  /** After a save: stop capturing the page and hide the highlight; the host stays for the undo toast. */
  readonly standDown: () => void;
  readonly destroy: () => void;
}

/** Highest z-index: the overlay must sit above the page. */
const TOP_LAYER = '2147483647';
const ACCENT = '#2563eb';
/** The hint pill (D-104): top-centre, inside the viewport, pill-shaped. */
const PILL_TOP = '12px';
const PILL_GUTTER = '24px';
const PILL_PADDING = '6px 12px';
const PILL_RADIUS = '999px';
const NAV_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']); // i18n-exempt: key names
const SWALLOWED = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'contextmenu', 'dblclick'] as const;
/** Forced colours: system colours, no background tint (no motion is used anywhere). */
/** How often the overlay checks it is still attached and on top (security review MEDIUM-1). */
const GUARD_INTERVAL_MS = 250;
/**
 * A page popover that opens again after ours goes above it (J15): each trusted open puts ours back on top,
 * and a page that keeps doing it is fighting us, so past this many the picker ends (design review). Covering is
 * then denial of service only; the panel's own visibility gate stops a covered click from acting.
 */
export const MAX_PROMOTIONS = 8;
const SHEET = '@media (forced-colors: active){[data-box]{outline-color:Highlight!important;background:transparent!important}[data-label],[data-hint]{background:Canvas!important;color:CanvasText!important;border:1px solid CanvasText!important}}'; // i18n-exempt: CSS

interface Parts { readonly host: HTMLElement; readonly root: ShadowRoot; readonly layer: HTMLElement; readonly box: HTMLElement; readonly label: HTMLElement; readonly hint: HTMLElement; readonly live: HTMLElement; readonly focus: HTMLElement }

function setStyles(el: HTMLElement, styles: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value, 'important');
}

function element(doc: Document, styles: Readonly<Record<string, string>>, attrs: Readonly<Record<string, string>> = {}): HTMLElement {
  const el = createElementIn(doc, 'div');
  setStyles(el, styles);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

function adoptSheet(root: ShadowRoot): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(SHEET);
    root.adoptedStyleSheets = [sheet];
  } catch {
    // No constructable sheets: forced-colours tuning is lost, the overlay still works.
  }
}

/** (Re)enters the top layer: a popover shown later goes above the ones shown before it. */
function promote(host: HTMLElement): void {
  if (typeof host.showPopover !== 'function') return;
  if (!host.hasAttribute('popover')) host.setAttribute('popover', 'manual');
  if (host.matches(':popover-open')) host.hidePopover();
  host.showPopover();
}

/** True when the page holds a modal (`<dialog>` via `showModal`): everything else, us included, is inert. */
function pageModalOpen(doc: Document): boolean {
  try {
    return queryOne(doc, ':modal') !== null;
  } catch {
    // An engine without `:modal`: no page modal can be detected, so none is assumed.
    return false;
  }
}

/** Open page popovers not yet seen (they may sit above ours). */
function newPopovers(doc: Document, host: Element, seen: WeakSet<Element>): readonly Element[] {
  try {
    return queryAll(doc, ':popover-open').filter((e) => e !== host && !seen.has(e));
  } catch {
    // An engine without `:popover-open`: no page popover to step above.
    return [];
  }
}

function buildDom(doc: Document, focusLabel: string, hintText: string): Parts {
  // A manual popover puts the host in the top layer, above the page's z-indexes (security review MEDIUM-1).
  const host = element(doc, { all: 'initial', position: 'fixed', inset: '0', width: '100%', height: '100%', margin: '0', border: '0', padding: '0',
    background: 'transparent', overflow: 'visible', 'max-width': 'none', 'max-height': 'none', 'z-index': TOP_LAYER, 'pointer-events': 'none' });
  const root = host.attachShadow({ mode: 'closed' });
  adoptSheet(root);
  const layer = element(doc, { position: 'fixed', inset: '0', 'pointer-events': 'auto', cursor: 'crosshair', background: 'transparent' });
  const box = element(doc, { position: 'fixed', 'pointer-events': 'none', background: 'rgba(37,99,235,0.2)', outline: `2px solid ${ACCENT}`, 'box-sizing': 'border-box' }, { 'data-box': '' }); // i18n-exempt: CSS
  const label = element(doc, { position: 'fixed', 'pointer-events': 'none', font: '12px/1.4 system-ui,sans-serif', background: ACCENT, color: '#fff', padding: '1px 4px' }, { 'data-label': '' });
  // Seen, not read: the focus target's name already says the same to assistive tech.
  const hint = element(doc, { position: 'fixed', top: PILL_TOP, left: '50%', transform: 'translateX(-50%)', 'max-width': `calc(100vw - ${PILL_GUTTER})`,
    'pointer-events': 'none', font: '13px/1.4 system-ui,sans-serif', background: ACCENT, color: '#fff', padding: PILL_PADDING, 'border-radius': PILL_RADIUS },
  { 'data-hint': '', 'aria-hidden': 'true' });
  hint.textContent = hintText;
  const live = element(doc, { position: 'fixed', width: '1px', height: '1px', overflow: 'hidden', 'clip-path': 'inset(50%)' }, { role: 'status', 'aria-live': 'polite' });
  const focus = element(doc, { position: 'fixed', width: '1px', height: '1px', overflow: 'hidden', 'clip-path': 'inset(50%)' },
    { tabindex: '-1', role: 'application', 'aria-label': focusLabel });
  root.append(layer, box, label, hint, live, focus);
  const page = rootOf(doc);
  if (page === null) throw new Error('no document element');
  page.append(host);
  promote(host);
  return { host, root, layer, box, label, hint, live, focus };
}

const defaultHasBox = (el: Element): boolean => {
  const r = rectOf(el);
  return r.width > 0 && r.height > 0;
};

/** Starts the overlay; the caller must call `destroy` when the picker ends. */
export function createOverlay(env: OverlayEnv): Overlay {
  const parts = buildDom(env.document, env.label, env.hint);
  const showHint = (shown: boolean): void => { setStyles(parts.hint, { display: shown ? 'block' : 'none' }); };
  const trusted = env.isTrusted ?? ((e: Event) => e.isTrusted);
  const hasBox = env.hasBox ?? defaultHasBox;
  const skip = (el: Element): boolean => el === parts.host || !hasBox(el);
  const previousFocus = activeOf(env.document);
  const seen = new WeakSet<Element>();
  let current: Element | null = null;
  let picking = true;
  let live = true;
  let promotions = 0;

  const highlight = (el: Element | null | undefined): void => {
    if (el === null || el === undefined || !isPickable(el, skip)) return;
    current = el;
    const r = rectOf(el);
    setStyles(parts.box, { top: `${String(r.top)}px`, left: `${String(r.left)}px`, width: `${String(r.width)}px`, height: `${String(r.height)}px` });
    setStyles(parts.label, { top: `${String(Math.max(0, r.top - 20))}px`, left: `${String(Math.max(0, r.left))}px` });
    const text = describeElement(el, r);
    parts.label.textContent = text;
    parts.live.textContent = text;
  };
  const under = (x: number, y: number): Element | undefined => env.elementsFromPoint(x, y).find((el) => isPickable(el, skip));
  const pick = (el: Element | null | undefined): void => {
    if (el === null || el === undefined || !picking) return;
    highlight(el);
    picking = false;
    showHint(false);
    env.onPick(el);
  };

  const onMove = (e: MouseEvent): void => { if (picking && trusted(e)) highlight(under(e.clientX, e.clientY)); };
  const onPointer = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && e instanceof MouseEvent && trusted(e)) pick(under(e.clientX, e.clientY) ?? current);
  };
  const onKey = (e: KeyboardEvent): void => {
    const handled = trusted(e) && (e.key === 'Escape' || (picking && (e.key === 'Enter' || NAV_KEYS.has(e.key))));
    if (!handled) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') env.onCancel();
    else if (e.key === 'Enter') pick(current);
    else if (current !== null) highlight(step(current, e.key as NavKey, skip));
  };

  // A host the page removed, or a page modal (which makes us inert): the picker ends. A page popover
  // opened after ours: ours is promoted above it again.
  const guard = (): void => {
    if (!isConnected(parts.host) || pageModalOpen(env.document)) {
      env.onCancel();
      return;
    }
    const others = newPopovers(env.document, parts.host, seen);
    for (const e of others) seen.add(e);
    if (others.length > 0) promote(parts.host);
  };

  /** A trusted page popover opening (again): back on top once it is open, or end the run past the cap. */
  const repromote = (): void => {
    if (!live) return;
    promotions += 1;
    if (promotions > MAX_PROMOTIONS) env.onCancel();
    else promote(parts.host);
  };
  const onToggle = (e: Event): void => {
    if (!trusted(e) || e.target === parts.host || (e as Event & { readonly newState?: unknown }).newState !== 'open') return;
    env.window.setTimeout(repromote, 0);
  };

  try {
    highlight(under(env.window.innerWidth / 2, env.window.innerHeight / 2) ?? bodyOf(env.document));
  } catch (error) {
    // Nothing is listening yet: take the host out again and let the caller end the run.
    parts.host.remove();
    throw error;
  }
  env.window.addEventListener('mousemove', onMove, true);
  env.window.addEventListener('keydown', onKey, true);
  for (const type of SWALLOWED) env.window.addEventListener(type, onPointer, true);
  const timer = env.window.setInterval(guard, GUARD_INTERVAL_MS);
  env.document.addEventListener('beforetoggle', onToggle, true);
  const detach = (): void => {
    env.window.removeEventListener('mousemove', onMove, true);
    env.window.removeEventListener('keydown', onKey, true);
    for (const type of SWALLOWED) env.window.removeEventListener(type, onPointer, true);
  };
  parts.focus.focus();

  return {
    current: () => current,
    pickNow: (el) => {
      if (!picking || !isPickable(el, skip)) return false;
      pick(el);
      return true;
    },
    mark: (el) => { highlight(el); },
    announcement: () => parts.live.textContent,
    resume: () => { picking = true; showHint(true); parts.focus.focus(); },
    mount: (node) => { parts.root.append(node); },
    standDown: () => {
      detach();
      for (const el of [parts.layer, parts.box, parts.label, parts.hint]) setStyles(el, { display: 'none' });
    },
    destroy: () => {
      live = false;
      env.window.clearInterval(timer);
      env.document.removeEventListener('beforetoggle', onToggle, true);
      detach();
      parts.host.remove();
      if (previousFocus instanceof HTMLElement && isConnected(previousFocus)) previousFocus.focus();
    },
  };
}
