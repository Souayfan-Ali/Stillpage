/**
 * Observing a fixture right after a state change (a level change, a pause expiry, an update). Chrome's
 * `updateDynamicRules` and `updateContentScripts` resolve before every new load sees the change: measured
 * under load (P2-47 stability, 2026-11-14), the first page load after a reconcile that had answered
 * `applied` — with the Off `allowAllRequests` rule already listed by `getDynamicRules` — still had its
 * subresource blocked; the very next load did not. So an observation taken after a change loads the page
 * again until it matches or `windowMs` is spent; the last reading is returned either way. No Playwright
 * import, so the logic is unit-tested in Vitest.
 */
export interface Visit {
  readonly wanted: readonly unknown[];
  readonly actual: readonly unknown[];
}

/** Window in which a change must reach new loads: not a product budget (performance notes §2.4 measures that); at load 38 one reload of 3 s settle was not enough, so it allows several. */
export const PROPAGATION_WINDOW_MS = 10_000;

const same = (v: Visit): boolean => JSON.stringify(v.actual) === JSON.stringify(v.wanted);

export async function settleVisits(visit: () => Promise<Visit>, windowMs: number, now: () => number = Date.now): Promise<Visit & { visits: number }> {
  const deadline = now() + windowMs;
  let last = await visit();
  let visits = 1;
  while (!same(last) && now() < deadline) {
    last = await visit();
    visits += 1;
  }
  return { ...last, visits };
}
