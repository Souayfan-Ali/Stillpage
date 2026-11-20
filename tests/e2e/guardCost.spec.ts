/**
 * P2-57 / P2-58 guard cost (performance notes §2.3): main-thread script time of a top-level document with no click,
 * as S-20 measured it (CDP `Performance.getMetrics` ScriptDuration on a blank page), in three set-ups of
 * the same build: no script, an empty ISOLATED control script (`popup-strict.js`, a one-line flag), and
 * the guard pair (`popup-sentinel.js` ISOLATED + `popup-shim.js` MAIN). 1× and 4× CPU, N loads each.
 * Record-only and load-sensitive (`@perf`, `npm run test:perf`): the figures and the load go to the log.
 * P2-47 quiet pass: the set-ups are interleaved in rounds (load drift hits all alike), and TaskDuration
 * (every main-thread task, so isolated-world creation too) is reported beside ScriptDuration (D-48).
 */
import { expect, type BrowserContext, type Worker } from '@playwright/test';
import { test } from './fixtures.js';

const ROUNDS = 6;
const PER_ROUND = 5;
const ORIGIN = 'https://cost.example';
type Setup = 'none' | 'control' | 'guard';

const pctl = (v: readonly number[], q: number): number => [...v].sort((a, b) => a - b)[Math.ceil(v.length * q) - 1] ?? Infinity;
const round = (x: number): number => Math.round(x * 100) / 100;

async function setUp(sw: Worker, setup: Setup): Promise<void> {
  await sw.evaluate(async ({ origin, which }) => {
    const ids = (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).filter((id) => id.startsWith('cost-'));
    if (ids.length > 0) await chrome.scripting.unregisterContentScripts({ ids });
    const base = { matches: [`${origin}/*`], runAt: 'document_start' as const, allFrames: false, persistAcrossSessions: false };
    const scripts = which === 'control' ? [{ id: 'cost-control', js: ['popup-strict.js'], world: 'ISOLATED' as const, ...base }]
      : which === 'guard' ? [{ id: 'cost-sentinel', js: ['popup-sentinel.js'], world: 'ISOLATED' as const, ...base }, { id: 'cost-shim', js: ['popup-shim.js'], world: 'MAIN' as const, ...base }] : [];
    if (scripts.length > 0) await chrome.scripting.registerContentScripts(scripts);
  }, { origin: ORIGIN, which: setup });
}

interface Sample {
  readonly script: number;
  readonly task: number;
}

async function sample(context: BrowserContext, rate: number): Promise<Sample> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.goto(`${ORIGIN}/`);
  await page.waitForTimeout(30);
  const { metrics } = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  await page.close();
  const ms = (name: string): number => (metrics.find((m) => m.name === name)?.value ?? NaN) * 1000;
  return { script: ms('ScriptDuration'), task: ms('TaskDuration') };
}

const summary = (v: readonly number[]): { readonly median: number; readonly p95: number } => ({ median: round(pctl(v, 0.5)), p95: round(pctl(v, 0.95)) });

test('guard cost with no click: sentinel + shim vs none and vs an empty ISOLATED script, 1× and 4× (record-only)', { tag: '@perf' }, async ({ context, serviceWorker }) => {
  test.setTimeout(600_000);
  await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] !== undefined), { timeout: 120_000 }).toBe(true);
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body>blank</body></html>' }));
  const runs = new Map<string, Sample[]>();
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const setup of ['none', 'control', 'guard'] as const) {
      await setUp(serviceWorker, setup);
      for (const rate of [1, 4]) {
        await sample(context, rate);
        const key = `${setup}_${String(rate)}x`;
        for (let i = 0; i < PER_ROUND; i += 1) runs.set(key, [...(runs.get(key) ?? []), await sample(context, rate)]);
      }
    }
  }
  const out = Object.fromEntries(
    [...runs].map(([key, v]) => [key, { script: summary(v.map((x) => x.script)), task: summary(v.map((x) => x.task)), n: v.length }]),
  );
  test.info().annotations.push({ type: 'guard cost', description: JSON.stringify(out) });
  for (const c of Object.values(out)) expect(Number.isFinite(c.script.p95) && Number.isFinite(c.task.p95)).toBe(true);
});
