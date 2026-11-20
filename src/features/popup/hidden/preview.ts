/**
 * The panel side of "Show on page" (P2-22b, D-50): one preview at a time. `inject` runs the packaged
 * `showOnPage` in the tab (the panel's own `scripting.executeScript`, no worker message); its answer is
 * validated before anything is said. The page reverts itself after `SHOW_MS`; the panel's own timer
 * only clears the pressed state and says so. `stop` asks the page to revert now (leaving the view, the
 * panel closing); it never waits.
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import * as v from 'valibot';
import { SHOW_STRINGS } from './strings.js';

/** How long one preview lasts (design review, P2-22b: long enough to find the outline beside the panel). */
export const SHOW_MS = 20_000;
/** The page caps the elements it touches (`showOnPage`). */
const MAX_SHOWN = 200;

const ResultSchema = v.union([
  v.strictObject({ shown: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SHOWN)) }),
  v.strictObject({ error: v.literal('invalid') }),
]);

/** Runs `showOnPage(selector, ms)` in the tab's top frame; resolves with its raw answer. */
export type Inject = (selector: string | null, ms: number) => Promise<unknown>;

export interface Preview {
  /** The selector shown on the page now, or `null`. */
  readonly active: ReadonlySignal<string | null>;
  /** For the view's `role="status"` line. */
  readonly status: ReadonlySignal<string>;
  /** Shows `selector`, or stops it when it is the one shown. */
  toggle(selector: string): Promise<void>;
  /** Reverts now, without waiting (unmount, `pagehide`). */
  stop(): void;
}

export function createPreview(inject: Inject): Preview {
  const active = signal<string | null>(null);
  const status = signal('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;

  const ended = (text: string): void => {
    clearTimeout(timer);
    active.value = null;
    status.value = text;
  };

  const answerOf = async (selector: string): Promise<v.InferOutput<typeof ResultSchema> | null> => {
    const raw = await inject(selector, SHOW_MS).catch(() => null);
    const parsed = v.safeParse(ResultSchema, raw);
    return parsed.success ? parsed.output : null;
  };

  const show = async (selector: string): Promise<void> => {
    const answer = await answerOf(selector);
    const shown = answer !== null && 'shown' in answer ? answer.shown : null;
    if (shown === null || shown === 0) {
      ended(shown === 0 ? SHOW_STRINGS.noMatch : SHOW_STRINGS.failed);
      return;
    }
    clearTimeout(timer);
    active.value = selector;
    status.value = SHOW_STRINGS.shown(shown, SHOW_MS);
    timer = setTimeout(() => {
      ended(SHOW_STRINGS.reverted);
    }, SHOW_MS);
  };

  const toggle = async (selector: string): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      if (active.value === selector) {
        await inject(null, 0).catch(() => null);
        ended(SHOW_STRINGS.reverted);
      } else {
        await show(selector);
      }
    } finally {
      busy = false;
    }
  };

  const stop = (): void => {
    if (active.value === null && !busy) return;
    clearTimeout(timer);
    active.value = null;
    void inject(null, 0).catch(() => null);
  };

  return { active, status, toggle, stop };
}
