/**
 * P2-47 (performance notes §2.2, §2.4): toolbar-panel latency on the real build, the S-06 method — "click" ≈ the
 * navigation start of `popup.html?tabId=`, the worker stopped first (cold) or left running (warm),
 * interleaved. Shell painted = `first-paint` (the static shell is an empty surface since P2-40, so the first
 * contentful paint is the first render, reported beside it); live data = the state header's `data-state`
 * element (it only renders once `q/tabState` answered); long tasks (> 50 ms) counted by a
 * PerformanceObserver installed before the page's own scripts. The dashboard's navigation → interactive
 * is the time its first form control exists. performance notes §2.2 "cold start → popup query answered": an open panel
 * page sends `q/tabState` right after the worker was stopped, so the round trip includes the worker's start.
 * D-64's own share: the duration of the entry chunk's `v8.evaluateModule` in a Chrome trace of a cold open.
 * Record-only and load-sensitive (`@perf`, `npm run test:perf`).
 */
import { loadavg } from 'node:os';
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { stopWorker } from './helpers/bootCounter.js';
import { closeAll, extensionWorker, launch, newProfile, removeProfile, startFixtureServer, type FixtureServer } from './helpers/browser.js';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { tabIdOf } from './helpers/session.js';

const RUNS = 15;
const SHELL_MS = 100;
const LIVE_MS = 250;
const DASHBOARD_MS = 500;
const QUERY_MS = 200;
/** D-64: module evaluation + first render of the panel, cold. */
const OWN_SHARE_MS = 10;
const ENTRY_CHUNK = /\/chunks\/popup-[\w-]+\.js$/;

interface TraceEvent {
  readonly name: string;
  readonly dur?: number;
  readonly args?: { readonly data?: { readonly url?: string } };
}

interface Marks {
  readonly paint: number;
  readonly fcp: number;
  readonly live: number;
  readonly longTasks: number;
}

/** Runs in the panel before its scripts: when the first matching element appears, and long tasks. */
const OBSERVE = (selector: string): void => {
  const w = self as unknown as { __p247: { live?: number; longTasks: number } };
  w.__p247 = { longTasks: 0 };
  new PerformanceObserver((list) => {
    w.__p247.longTasks += list.getEntries().length;
  }).observe({ type: 'longtask', buffered: true });
  const seen = (): void => {
    if (w.__p247.live === undefined && document.querySelector(selector) !== null) w.__p247.live = performance.now();
  };
  new MutationObserver(seen).observe(document, { subtree: true, childList: true, attributes: true });
};

const pctl = (v: readonly number[], q: number): number => [...v].sort((a, b) => a - b)[Math.ceil(v.length * q) - 1] ?? Infinity;
const stat = (v: readonly number[]): string => `median ${pctl(v, 0.5).toFixed(0)}, p95 ${pctl(v, 0.95).toFixed(0)} ms`;

async function open(context: BrowserContext, url: string, selector: string): Promise<Marks> {
  const page: Page = await context.newPage();
  await page.addInitScript(OBSERVE, selector);
  await page.goto(url);
  await page.waitForFunction(() => (self as unknown as { __p247?: { live?: number } }).__p247?.live !== undefined, null, { timeout: 10_000 });
  await page.waitForTimeout(100);
  const marks = await page.evaluate(() => {
    const w = self as unknown as { __p247: { live: number; longTasks: number } };
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? NaN;
    const paint = performance.getEntriesByName('first-paint')[0]?.startTime ?? NaN;
    return { paint, fcp, live: w.__p247.live, longTasks: w.__p247.longTasks };
  });
  await page.close();
  return marks;
}

/** In an open panel page: one `q/tabState` round trip, ms. */
const queryOnce = (page: Page, tabId: number): Promise<number> => page.evaluate(async (tab) => {
  const t0 = performance.now();
  const answer = await chrome.runtime.sendMessage<unknown, { ok?: boolean }>({ v: 1, type: 'q/tabState', id: `perf-${String(Math.round(t0))}`, payload: { tabId: tab } });
  if (answer.ok !== true) throw new Error(`q/tabState refused: ${JSON.stringify(answer)}`);
  return performance.now() - t0;
}, tabId);

let server: FixtureServer;
test.beforeAll(async () => {
  server = await startFixtureServer();
});
test.afterAll(async () => {
  await closeAll();
  await server.close();
});

interface Started {
  readonly context: BrowserContext;
  readonly worker: Worker;
  readonly profile: string;
  readonly id: string;
  readonly tabId: number;
  readonly panel: string;
}

/** A fresh profile with the build, reconciled, and one web page whose tab the panel is opened for. */
async function start(): Promise<Started> {
  const profile = await newProfile();
  const context = await launch(profile, BUILD_DIR);
  const worker = await extensionWorker(context);
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] !== undefined), { timeout: 120_000 }).toBe(true);
  const id = new URL(worker.url()).host;
  const site = await context.newPage();
  await site.goto(`${server.origin}/`);
  const tabId = await tabIdOf(worker, server.origin);
  return { context, worker, profile, id, tabId, panel: `chrome-extension://${id}/popup.html?tabId=${String(tabId)}` };
}

async function stop(s: Started): Promise<void> {
  await s.context.close();
  await removeProfile(s.profile);
}

test('toolbar panel and dashboard latency, worker cold and warm (record-only)', { tag: '@perf' }, async () => {
  test.setTimeout(300_000);
  const s = await start();
  const cells: Record<'cold' | 'warm', Marks[]> = { cold: [], warm: [] };
  const dashboard: Marks[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    await stopWorker(s.profile, s.id);
    cells.cold.push(await open(s.context, s.panel, '[data-state]'));
    cells.warm.push(await open(s.context, s.panel, '[data-state]'));
    dashboard.push(await open(s.context, `chrome-extension://${s.id}/dashboard.html`, 'main input, main button, main select'));
  }
  const lines = Object.entries(cells).map(([k, v]) =>
    `${k}: shell (first paint) ${stat(v.map((m) => m.paint))}; first render (FCP) ${stat(v.map((m) => m.fcp))}; live ${stat(v.map((m) => m.live))}; long tasks ${String(v.reduce((n, m) => n + m.longTasks, 0))}`);
  lines.push(`dashboard → first control ${stat(dashboard.map((m) => m.live))}; long tasks ${String(dashboard.reduce((n, m) => n + m.longTasks, 0))}`);
  test.info().annotations.push({ type: 'panel latency', description: `n=${String(RUNS)}; ${lines.join(' | ')}; load average ${loadavg().map((l) => l.toFixed(2)).join(', ')}` });
  await stop(s);
  // D-64: the row is the cold case (the extension process is gone 30 s after the last event).
  expect.soft(pctl(cells.cold.map((m) => m.paint), 0.95)).toBeLessThanOrEqual(SHELL_MS);
  expect.soft(pctl(cells.cold.map((m) => m.live), 0.95)).toBeLessThanOrEqual(LIVE_MS);
  expect.soft(pctl(dashboard.map((m) => m.live), 0.95)).toBeLessThanOrEqual(DASHBOARD_MS);
});

test('cold start → popup query answered ≤ 200 ms (record-only)', { tag: '@perf' }, async () => {
  test.setTimeout(300_000);
  const s = await start();
  // An open panel page keeps the extension process: only the worker starts cold here.
  const asker = await s.context.newPage();
  await asker.goto(s.panel);
  const query: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    await stopWorker(s.profile, s.id);
    query.push(await queryOnce(asker, s.tabId));
  }
  test.info().annotations.push({ type: 'popup query', description: `n=${String(RUNS)}; cold start → q/tabState answered ${stat(query)}; load average ${loadavg().map((l) => l.toFixed(2)).join(', ')}` });
  await stop(s);
  expect.soft(pctl(query, 0.95)).toBeLessThanOrEqual(QUERY_MS);
});

/** The panel entry's module evaluation (its import graph and the synchronous first render), from a Chrome trace. */
async function ownShare(s: Started, site: Page): Promise<number> {
  const cdp = await s.context.newCDPSession(site);
  const events: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', (e) => {
    events.push(...(e.value as unknown as TraceEvent[]));
  });
  const done = new Promise<void>((resolve) => {
    cdp.once('Tracing.tracingComplete', () => {
      resolve();
    });
  });
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8', transferMode: 'ReportEvents' });
  await open(s.context, s.panel, '[data-state]');
  await cdp.send('Tracing.end');
  await done;
  await cdp.detach();
  const entry = events.find((e) => e.name === 'v8.evaluateModule' && ENTRY_CHUNK.test(e.args?.data?.url ?? ''));
  return (entry?.dur ?? NaN) / 1000;
}

test('own share of the cold first paint: module evaluation + first render ≤ 10 ms p95 (D-64, record-only)', { tag: '@perf' }, async () => {
  test.setTimeout(300_000);
  const s = await start();
  const site = s.context.pages().find((p) => p.url().startsWith(server.origin));
  if (site === undefined) throw new Error('no site page');
  const share: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    await stopWorker(s.profile, s.id);
    share.push(await ownShare(s, site));
  }
  test.info().annotations.push({ type: 'own share', description: `n=${String(RUNS)}; panel module evaluation + first render, cold ${stat(share)}; load average ${loadavg().map((l) => l.toFixed(2)).join(', ')}` });
  await stop(s);
  expect(share.every(Number.isFinite), 'the entry chunk was traced').toBe(true);
  expect.soft(pctl(share, 0.95)).toBeLessThanOrEqual(OWN_SHARE_MS);
});
