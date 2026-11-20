/**
 * Clickjacking gate of the picker panel (J15, P2-42; design review). The panel is an extension iframe inside a
 * hostile page: the page can draw a decoy over it (a top-layer popover it re-shows, a `pointer-events:none`
 * cover, opacity or a filter on its own `<html>`) and lure a real click onto "Hide always" or "Undo".
 * Z-order cannot be won by polling, so the actions ask IntersectionObserver v2 instead: a button acts only
 * after it has been continuously visible (not covered, no opacity, filter or transform effect, in this
 * frame and its ancestors) for `VISIBLE_FOR_MS`. No entry yet, or no v2 support, means not visible.
 */

/** How long an action button must have been visible without interruption before a click counts. */
export const VISIBLE_FOR_MS = 400;
/** IntersectionObserver v2 checks visibility at most this often (its minimum is 100 ms). */
const OBSERVER_DELAY_MS = 100;

/** Whether a button may act now; `onChange` reports the raw visibility (for `aria-disabled`). */
export type VisibilityWatch = (target: Element, onChange?: (visible: boolean) => void) => () => boolean;

export interface VisibilityTracker {
  readonly record: (visible: boolean) => void;
  readonly visible: () => boolean;
}

/** Continuous-visibility clock: any not-visible reading restarts it. */
export function visibilityTracker(now: () => number, minMs = VISIBLE_FOR_MS): VisibilityTracker {
  let since: number | null = null;
  return {
    record: (visible) => {
      if (!visible) since = null;
      else since ??= now();
    },
    visible: () => since !== null && now() - since >= minMs,
  };
}

interface V2Entry {
  readonly isIntersecting: boolean;
  readonly intersectionRatio: number;
  readonly isVisible?: boolean;
}

type ObserverCtor = new (callback: (entries: readonly V2Entry[]) => void, options: object) => { observe: (target: Element) => void };

/** True when this browser reports visibility (`isVisible`, IntersectionObserver v2). */
export function supportsVisibility(win: { readonly IntersectionObserver?: unknown; readonly IntersectionObserverEntry?: { readonly prototype: object } }): boolean {
  return typeof win.IntersectionObserver === 'function' && win.IntersectionObserverEntry !== undefined && 'isVisible' in win.IntersectionObserverEntry.prototype;
}

/** The real watch: one v2 observer per button. Without v2 support every button stays not visible (fail closed). */
export function intersectionWatch(win: Window & typeof globalThis, now: () => number): VisibilityWatch {
  const supported = supportsVisibility(win);
  return (target, onChange) => {
    const tracker = visibilityTracker(now);
    onChange?.(false);
    if (!supported) return tracker.visible;
    const Observer = win.IntersectionObserver as unknown as ObserverCtor;
    const observer = new Observer((entries) => {
      const last = entries.at(-1);
      const visible = last !== undefined && last.isIntersecting && last.intersectionRatio >= 1 && last.isVisible === true;
      tracker.record(visible);
      onChange?.(visible);
    }, { trackVisibility: true, delay: OBSERVER_DELAY_MS, threshold: 1 });
    observer.observe(target);
    return tracker.visible;
  };
}
