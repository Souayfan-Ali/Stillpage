/**
 * The in-page notice (P2-57, P2-59; pop-up notes §11, UI notes §6a): closed shadow root, top-right (top-left on
 * right-to-left pages), `role="status"`, 8 s, one at a time with further blocks coalesced into a count.
 * A button acts only on a trusted activation once `NOTICE_ARM_DELAY_MS` has passed since the latest update
 * and while IntersectionObserver v2 has reported the notice visible and unoccluded for
 * `NOTICE_VISIBLE_FOR_MS` (J15 finding, design review: pass-through decoys; fail closed without v2). A pointer click
 * must also land inside the button with the notice on top; a keyboard activation must come from the focused
 * button. Esc dismisses; it never takes focus. Nothing persistent can be set here.
 */
import { NOTICE_ARM_DELAY_MS, NOTICE_VISIBLE_FOR_MS } from '../../core/popup/constants.js';
import type { Say } from './strings.js';

const SHOW_MS = 8_000;
/** A notice larger than this was restyled by the page (security review MEDIUM-1). */
const MAX_BOX = { width: 480, height: 160 } as const;
/** Smaller than this, the page shrank it (`zoom` on its root; IntersectionObserver v2 does not flag size). */
const MIN_BOX = { width: 120, height: 32 } as const;
/** IntersectionObserver v2 checks visibility at most this often (its minimum). */
const OBSERVER_DELAY_MS = 100;
/**
 * One inline declaration list (CSSOM, so a page CSP that forbids inline styles does not apply). Every
 * declaration is `!important`: after `all:initial!important` a plain one loses. `direction` is inherited
 * (`all` leaves it), so `inset-inline-end` mirrors the corner on right-to-left pages; system colours follow
 * the light or dark scheme.
 */
const BOX_CSS = 'all:initial!important;position:fixed!important;top:12px!important;inset-inline-end:12px!important;z-index:2147483647!important;max-width:440px!important;color-scheme:light dark!important;background:Canvas!important;color:CanvasText!important;outline:1px solid!important;font:13px/1.4 system-ui,sans-serif!important;padding:8px!important'; // i18n-exempt: CSS

export interface NoticeAction {
  readonly label: string;
  /** Runs on an accepted activation; a returned line replaces the notice's text (the buttons go). */
  readonly run: () => string | undefined;
}

export interface Notice {
  /** Shows `text`, or "N pop-ups blocked · `subject`" while an earlier notice is still up. */
  show(text: string, subject: string, actions: readonly NoticeAction[]): void;
  /** Whether `target` is the notice's host (what the page and the sentinel's listeners see of it). */
  owns(target: unknown): boolean;
}

/** Starts watching `target`; the result says whether it has been visible long enough. `stop` ends it. */
export type Watch = (target: Element) => { readonly visible: () => boolean; readonly stop: () => void };

interface V2Entry { readonly intersectionRatio: number; readonly isVisible?: boolean }
type ObserverCtor = new (cb: (entries: readonly V2Entry[]) => void, options: object) => { observe(t: Element): void; disconnect(): void };

/** The real watch: IntersectionObserver v2 on the notice; any not-visible report restarts the clock. */
export function visibilityWatch(win: { readonly IntersectionObserver?: unknown }, now: () => number): Watch {
  return (target) => {
    let since: number | null = null;
    const Observer = win.IntersectionObserver as ObserverCtor | undefined;
    const observer = Observer === undefined ? null : new Observer((entries) => {
      const last = entries.at(-1);
      since = last?.isVisible === true && last.intersectionRatio >= 1 ? since ?? now() : null;
    }, { trackVisibility: true, delay: OBSERVER_DELAY_MS, threshold: 1 });
    observer?.observe(target);
    return { visible: () => since !== null && now() - since >= NOTICE_VISIBLE_FOR_MS, stop: () => { observer?.disconnect(); } };
  };
}

export function createNotice(doc: Document, now: () => number, setTimer: (run: () => void, ms: number) => () => void, watch: Watch, say: Say): Notice {
  let host: HTMLElement | null = null;
  let count = 0;
  let cancel: () => void = () => undefined;
  const hide = (): void => { cancel(); host?.remove(); host = null; count = 0; };
  const onKey = (e: KeyboardEvent): void => { if (e.isTrusted && e.key === 'Escape') hide(); };
  return {
    owns: (target) => target !== null && target === host,
    show: (text, subject, actions) => {
      const shown = host === null ? 1 : count + 1;
      hide();
      count = shown;
      const shownAt = now();
      const box = doc.createElement('div');
      box.style.cssText = BOX_CSS;
      const ownStyle = box.style.cssText;
      const root = box.attachShadow({ mode: 'closed' });
      const line = doc.createElement('div');
      line.setAttribute('role', 'status');
      root.append(line);
      for (const action of [...actions, { label: '✕', run: () => undefined }]) {
        const b = doc.createElement('button');
        b.textContent = action.label;
        if (action.label === '✕') b.setAttribute('aria-label', say('notice_dismiss'));
        b.addEventListener('click', (e) => {
          const r = box.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const { clientX: x, clientY: y } = e;
          // A keyboard activation (detail 0) has no point: it must come from our focused button instead.
          const aimed = e.detail === 0 ? root.activeElement === b : doc.elementFromPoint(x, y) === box && x >= br.left && x <= br.right && y >= br.top && y <= br.bottom;
          // The host is light DOM: a page can restyle it (opacity 0, scaled over the page) or cover it.
          if (!e.isTrusted || now() - shownAt < NOTICE_ARM_DELAY_MS || !seen.visible() || !aimed || box.style.cssText !== ownStyle || r.width > MAX_BOX.width || r.height > MAX_BOX.height || r.width < MIN_BOX.width || r.height < MIN_BOX.height) return;
          const hint = action.run();
          if (hint === undefined) hide();
          else { line.textContent = hint; root.replaceChildren(line); }
        });
        root.append(b);
      }
      doc.documentElement.append(box);
      const seen = watch(box);
      doc.addEventListener('keydown', onKey, true);
      host = box;
      // Filled after insertion, so screen readers announce the live region's change.
      line.textContent = count > 1 ? String(count) + say('notice_blocked_many') + subject : text;
      const stopTimer = setTimer(hide, SHOW_MS);
      cancel = () => { stopTimer(); seen.stop(); doc.removeEventListener('keydown', onKey, true); };
    },
  };
}
