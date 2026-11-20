/**
 * Observer budget for procedural filtering (cosmetic notes §4): mutations are batched into one pass in the
 * next animation frame; when the passes take more than 50 ms in any 1 s window the interval doubles
 * (first step 16 ms, cap 1 s) and a counter records it; a pass that starts 5 s or more after the last
 * change of the interval halves it again (16 ms → none), so one heavy burst at load does not slow the
 * frame for good; while the tab is hidden nothing runs and one rescan follows when it is visible again. Pure: the clock is injected, so it is unit-tested with a
 * fake one. The engine's own pass cannot be sliced (uBO keeps a per-selector budget inside it), so the
 * 4 ms slice of cosmetic notes §4 is enforced as backoff, not as a mid-pass yield.
 */

export interface SchedulerClock {
  now(): number;
  frame(cb: () => void): void;
  timeout(cb: () => void, ms: number): void;
}

interface SchedulerStats {
  readonly intervalMs: number;
  readonly backoffs: number;
}

export interface Scheduler {
  notify(): void;
  setHidden(hidden: boolean): void;
  stats(): SchedulerStats;
}

const WINDOW_MS = 1_000;
const WORK_LIMIT_MS = 50;
const FIRST_BACKOFF_MS = 16;
const MAX_INTERVAL_MS = 1_000;
/** Quiet time after which the interval steps back down by one halving. */
const DECAY_AFTER_MS = 5_000;

export function createScheduler(work: () => void, clock: SchedulerClock): Scheduler {
  let intervalMs = 0;
  let backoffs = 0;
  let intervalSetAt = 0;
  let scheduled = false;
  let hidden = false;
  let dirty = false;
  let spent: readonly { readonly at: number; readonly ms: number }[] = [];

  const account = (at: number, ms: number): void => {
    spent = [...spent.filter((s) => s.at > at - WINDOW_MS), { at, ms }];
    if (spent.reduce((n, s) => n + s.ms, 0) <= WORK_LIMIT_MS) return;
    intervalMs = Math.min(intervalMs === 0 ? FIRST_BACKOFF_MS : intervalMs * 2, MAX_INTERVAL_MS);
    backoffs += 1;
    intervalSetAt = at;
    spent = [];
  };

  const decay = (at: number): void => {
    if (intervalMs === 0 || at - intervalSetAt < DECAY_AFTER_MS) return;
    intervalMs = intervalMs <= FIRST_BACKOFF_MS ? 0 : intervalMs / 2;
    intervalSetAt = at;
  };

  const run = (): void => {
    scheduled = false;
    if (hidden) {
      dirty = true;
      return;
    }
    const t0 = clock.now();
    decay(t0);
    try {
      work();
    } catch {
      // A failing pass must never stop the next one or break the page.
    }
    account(t0, clock.now() - t0);
  };

  const notify = (): void => {
    if (hidden) {
      dirty = true;
      return;
    }
    if (scheduled) return;
    scheduled = true;
    if (intervalMs === 0) clock.frame(run);
    else clock.timeout(() => { clock.frame(run); }, intervalMs);
  };

  return {
    notify,
    setHidden: (value) => {
      hidden = value;
      if (!value && dirty) {
        dirty = false;
        notify();
      }
    },
    stats: () => ({ intervalMs, backoffs }),
  };
}
