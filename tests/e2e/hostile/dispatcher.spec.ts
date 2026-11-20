/**
 * J15 · the MAIN-world scriptlet dispatcher (P1-37, security notes T1). A same-origin parent prepares each child
 * frame's realm before the child's `document_start` scripts run (Chromium reuses the initial about:blank
 * Window for a same-origin navigation): planted holders (frozen, accessor, pinned), poisoned natives
 * (`Object.create`, `getOwnPropertyDescriptor`, `Reflect.deleteProperty`, `Reflect.apply`), index accessors
 * on `Array.prototype`, getters on `Object.prototype`. Planted holders fail closed. Poisoned natives can make
 * a forged invocation run: the **accepted limit** in docs/limits.md ("Scriptlets in a frame its same-origin
 * parent prepared") and security notes T1 — no trusted native exists in such a realm, and the run has only the
 * page's own privileges in its own origin. What must hold everywhere: no exception on the page, nothing
 * left on `self`, nothing stored, no effect on other frames or origins, no extension network.
 */
import { test, expect } from '@playwright/test';
import { expectNoExtensionNetwork, openHostile, POLL, SESSION_TIMEOUT_MS, startHostile, stopHostile, type Hostile } from './harness.js';

interface ChildReport {
  readonly planted?: boolean;
  readonly adsEnabled?: unknown;
  readonly forged?: boolean;
  readonly queueLeft?: boolean;
  readonly plantError?: string;
}

/** Plants after which nothing forged may run (holders, and natives our code does not depend on for the decision). */
const FAIL_CLOSED = ['control', 'frozenHolder', 'accessorQueue', 'pinnedQueue', 'poisonedCreate', 'noDelete', 'arrayIndexAccessors', 'objectPrototypeGetters'];
/** The accepted limit (docs/limits.md): the realm's own natives decide, and the page chose them. */
const ACCEPTED_LIMIT = ['poisonedDescriptor', 'poisonedApply'];

let h: Hostile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(SESSION_TIMEOUT_MS);
  h = await startHostile();
});
test.afterAll(async () => { await stopHostile(); });

test('a same-origin parent that prepares the child realm: planted holders run nothing; no exception, nothing left, nothing stored', async () => {
  const storageBefore = await h.worker.evaluate(() => chrome.storage.local.get(null));
  const tab = await openHostile(h, 'dispatcher');
  const total = FAIL_CLOSED.length + ACCEPTED_LIMIT.length;
  await expect.poll(() => tab.evaluate(() => Object.keys((window as unknown as { __results: object }).__results).length), POLL).toBe(total);
  const { top, results, errors } = await tab.evaluate(() => {
    const w = window as unknown as { __topAdsEnabled: unknown; __results: Record<string, ChildReport>; __errors: string[] };
    return { top: w.__topAdsEnabled, results: w.__results, errors: w.__errors };
  });
  // Control: the list scriptlet ran in the parent and in an untouched child.
  expect(top).toBe(false);
  expect(results['control']).toMatchObject({ planted: true, adsEnabled: false, forged: false, queueLeft: false });
  for (const name of FAIL_CLOSED) {
    expect(results[name]?.planted, name).toBe(true);
    expect(results[name]?.forged, name).toBe(false);
    // The pinned (non-configurable) key is the page's own planted property, which no one can delete.
    if (name !== 'pinnedQueue') expect(results[name]?.queueLeft, name).toBe(false);
  }
  for (const name of ACCEPTED_LIMIT) {
    test.info().annotations.push({ type: 'accepted limit (docs/limits.md)', description: `${name}: forged invocation ran = ${String(results[name]?.forged)}` });
    expect(results[name]?.queueLeft, name).toBe(false);
  }
  expect(errors).toEqual([]);
  expect(await h.worker.evaluate(() => chrome.storage.local.get(null))).toEqual(storageBefore);
  // Nothing escaped to the parent: no queue key, no forged global.
  expect(await tab.evaluate(() => ({ q: Object.hasOwn(self, '__sl_q'), forged: (window as unknown as { forgedProbe?: unknown }).forgedProbe ?? null }))).toEqual({ q: false, forged: null });
  await tab.close();
});

test('a cross-origin parent cannot prepare the child, and a sandboxed (opaque-origin) child is unaffected: the list scriptlet runs', async () => {
  const tab = await openHostile(h, 'dispatcher-cross', 'https://other.hostile-dest.example');
  for (const name of ['cross', 'sandboxed']) {
    await expect.poll(() => tab.frame({ name })?.evaluate(() => (self as unknown as { __report?: ChildReport }).__report ?? null) ?? null, POLL).not.toBeNull();
    const report = await tab.frame({ name })?.evaluate(() => (self as unknown as { __report: ChildReport }).__report);
    expect(report, name).toMatchObject({ planted: false, adsEnabled: false, forged: false, queueLeft: false });
  }
  expect(await tab.evaluate(() => (window as unknown as { __errors: string[] }).__errors)).toEqual([]);
  await tab.close();
});

test('J16 row: no extension-initiated request during the dispatcher probes', () => {
  expectNoExtensionNetwork(h);
});
