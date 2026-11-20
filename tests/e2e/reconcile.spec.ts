/**
 * P1-14 (J1 skeleton, J7 and J13 halves): the built worker reconciles on install, on startup, on
 * permission change and after an in-place update; a re-run is a no-op; with "on click" access no
 * `-x` ruleset is enabled and the fixture ad script is blocked rather than loaded (S-10/S-19).
 * Local fixture server only; no survivor processes or profile dirs.
 */
import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createFixtureExtension, type FixtureExtension } from './helpers/fixtureExtension.js';
import {
  closeAll,
  expectNoSurvivors,
  extensionWorker,
  launch,
  newProfile,
  removeProfile,
  setHostAccess,
  startFixtureServer,
  updateInPlace,
  type FixtureServer,
} from './helpers/browser.js';
import { expectBudget } from './helpers/perf.js';
import { PROPAGATION_WINDOW_MS } from './helpers/settle.js';

const SETTLED = { timeout: PROPAGATION_WINDOW_MS, intervals: [250, 500, 1_000] };

/** D-19 (provisional): update applied → all registrations restored, window ≤ 3.5 s p95 (one sample per run). */
const UPDATE_WINDOW_MS = 3_500;
const POLL = { timeout: 10_000, intervals: [50, 100, 250] };
/**
 * The fixture's isolated script, plus the pop-up guard (P2-58): with the default mode `off` the worker
 * registers the sentinel, the shim and the Strict flag on the lists' Strict sites (`popup-strict-sites.json`),
 * whatever the host access (S-10: registrations never depend on grants).
 */
const SCRIPTS = ['iso:ads:1', 'popup-sentinel', 'popup-shim', 'popup-strict'];

interface WorkerState {
  readonly pending: boolean;
  readonly last: { reason: string; status: string; at: number; durationMs: number } | undefined;
  readonly rulesets: string[];
  readonly scripts: string[];
}

function readState(worker: Worker): Promise<WorkerState> {
  return worker.evaluate(async () => ({
    pending: (await chrome.storage.session.get('reconcile.pending'))['reconcile.pending'] === true,
    last: (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] as WorkerState['last'],
    rulesets: (await chrome.declarativeNetRequest.getEnabledRulesets()).sort(),
    scripts: (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).sort(),
  }));
}

async function settled(worker: Worker, reason: RegExp): Promise<WorkerState> {
  // Also wait until no run is in flight: one site-access change can fire two permission events,
  // and the second run must not still be applying when the test reads the state (review MEDIUM 9).
  await expect
    .poll(async () => {
      const state = await readState(worker);
      return state.pending ? '' : (state.last?.reason ?? '');
    }, POLL)
    .toMatch(reason);
  return readState(worker);
}

async function probe(context: BrowserContext, origin: string): Promise<Record<string, unknown>> {
  const page: Page = await context.newPage();
  try {
    await page.goto(`${origin}/`);
    return await page.evaluate(() => ({
      probe: document.documentElement.dataset['probe'] ?? null,
      adLoaded: (window as unknown as { adLoaded?: boolean }).adLoaded === true,
      adSurrogate: (window as unknown as { adSurrogate?: boolean }).adSurrogate === true,
    }));
  } finally {
    await page.close();
  }
}

let server: FixtureServer;
let extension: FixtureExtension;

test.beforeAll(async () => {
  server = await startFixtureServer();
  extension = await createFixtureExtension();
});

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await server.close();
  await extension.remove();
  await expectNoSurvivors();
});

test('install → reconciled; re-run is a no-op; content scripts cannot command', async () => {
  const profile = await newProfile();
  const context = await launch(profile, extension.dir);
  try {
    const worker = await extensionWorker(context);
    const id = new URL(worker.url()).host;
    const state = await settled(worker, /^installed:install$/);
    expect(state).toMatchObject({ last: { status: 'applied' }, rulesets: ['ubo', 'ubo-x'], scripts: SCRIPTS });
    expect(await probe(context, server.origin)).toEqual({ probe: 'ran', adLoaded: false, adSurrogate: true });

    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/e2e.html`);
    await expect.poll(() => page.title(), POLL).toContain('"ok":true');
    expect(JSON.parse(await page.title())).toEqual({ ok: true, data: { status: 'unchanged', skippedPacks: [] } });

    const cs = await context.newPage();
    await cs.goto(`${server.origin}/`);
    await expect.poll(() => cs.evaluate(() => document.documentElement.dataset['command'] ?? ''), POLL).toBe('forbidden-sender');
  } finally {
    await context.close();
    await removeProfile(profile);
  }
});

test('permission change: on click → block-only, -x off, ad blocked; all sites → -x back', async () => {
  const profile = await newProfile();
  const context = await launch(profile, extension.dir);
  try {
    const worker = await extensionWorker(context);
    const id = new URL(worker.url()).host;
    await settled(worker, /^installed:/);

    await setHostAccess(context, id, 'ON_CLICK');
    const restricted = await settled(worker, /^permissions$/);
    expect(restricted.rulesets).toEqual(['ubo']);
    expect(restricted.scripts).toEqual(SCRIPTS);
    // After an access change Chrome may apply it to new loads a little later (`helpers/settle.ts`).
    await expect.poll(() => probe(context, server.origin), SETTLED).toEqual({ probe: null, adLoaded: false, adSurrogate: false });

    await worker.evaluate(() => chrome.storage.session.remove('reconcile.last'));
    await setHostAccess(context, id, 'ON_ALL_SITES');
    const granted = await settled(worker, /^permissions$/);
    expect(granted.rulesets).toEqual(['ubo', 'ubo-x']);
    await expect.poll(() => probe(context, server.origin), SETTLED).toEqual({ probe: 'ran', adLoaded: false, adSurrogate: true });
  } finally {
    await context.close();
    await removeProfile(profile);
  }
});

test('in-place update: registrations and rulesets restored inside the window', { tag: '@budget' }, async () => {
  const profile = await newProfile();
  const context = await launch(profile, extension.dir);
  try {
    await settled(await extensionWorker(context), /^installed:/);
    await extension.setVersion('0.0.2');
    const { worker, startedAt } = await updateInPlace(context, profile, extension.dir);
    const state = await settled(worker, /^installed:update$/);

    expect(state).toMatchObject({ last: { status: 'applied' }, rulesets: ['ubo', 'ubo-x'], scripts: SCRIPTS });
    const windowMs = (state.last?.at ?? Infinity) - startedAt;
    test.info().annotations.push({ type: 'update window', description: `${String(windowMs)} ms (reconcile ${String(state.last?.durationMs)} ms)` });
    expectBudget('update window (ms)', windowMs, UPDATE_WINDOW_MS);
  } finally {
    await extension.setVersion('0.0.1');
    await context.close();
    await removeProfile(profile);
  }
});

test('browser restart: the worker reconciles again before the first page needs it', async () => {
  const profile = await newProfile();
  try {
    const first = await launch(profile, extension.dir);
    await settled(await extensionWorker(first), /^installed:/);
    await first.close();

    const second = await launch(profile, extension.dir);
    try {
      const state = await settled(await extensionWorker(second), /^(startup|installed:\w+)$/);
      expect(state).toMatchObject({ rulesets: ['ubo', 'ubo-x'], scripts: SCRIPTS });
      expect(await probe(second, server.origin)).toEqual({ probe: 'ran', adLoaded: false, adSurrogate: true });
    } finally {
      await second.close();
    }
  } finally {
    await removeProfile(profile);
  }
});
