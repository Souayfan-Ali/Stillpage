/**
 * P1-34 gates for `cosmetic-specific` in real Chromium (P1-34, cosmetic notes §2.3, performance notes §2.3):
 * no first-frame flash in 200 loads; no script of ours parsed in any frame of a host without filters
 * (top, same-site, cross-site and about:blank frames); `excludeMatches` with `matchOriginAsFallback`
 * on an about:blank child; one rule Chrome refuses never swallows the rest (joined stylesheet), and
 * the applier's own time from script start to adopted sheet.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createDefaultSettings } from '../../src/core/state/defaults.js';
import { loadFixtures } from '../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { closeAll, expectNoSurvivors, extensionWorker, newProfile } from './helpers/browser.js';
import { applySettings, createCorpusExtension, launchCorpus, reconciledSince, type CorpusExtension } from './helpers/corpus.js';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { expectBudget, PERF_RUN } from './helpers/perf.js';
import { PROPAGATION_WINDOW_MS } from './helpers/settle.js';

const LOADS = 200;
const ONE_PROCESS = ['--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process'];
const SELECTORS = 50;
/** performance notes §2.3: `document_start` → stylesheet adopted ≤ 2 ms p95; asserted by `test:perf`. */
const ADOPT_BUDGET_MS = 2;
/** Loads in the default run, which checks the stylesheet only (the timing needs `LOADS`). */
const CORRECTNESS_LOADS = 3;

let server: FixtureServer;
let extension: CorpusExtension;
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
  extension = await createCorpusExtension(loadFixtures());
});
test.afterEach(async () => {
  await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
  contexts.clear();
  await closeAll();
});
test.afterAll(async () => {
  await server.close();
  await extension.remove();
  await expectNoSurvivors();
});

async function start(extra: readonly string[] = []): Promise<{ context: BrowserContext; id: string; worker: Awaited<ReturnType<typeof extensionWorker>> }> {
  const since = Date.now();
  const context = await launchCorpus(await newProfile(), extension.dir, [...server.chromiumArgs, ...extra]);
  contexts.add(context);
  const worker = await extensionWorker(context);
  await reconciledSince(worker, since, /^installed:/);
  return { context, id: new URL(worker.url()).host, worker };
}

const pctl = (values: readonly number[], q: number): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] ?? Infinity;

/**
 * Extension script URLs parsed in the page and its in-process frames while `url` loads. Starts from
 * about:blank: `Debugger.enable` also reports the scripts of the document already loaded.
 */
async function extensionScripts(page: Page, url: string): Promise<readonly string[]> {
  await page.goto('about:blank');
  const cdp = await page.context().newCDPSession(page);
  const seen: string[] = [];
  cdp.on('Debugger.scriptParsed', (e: { url: string }) => {
    if (e.url.startsWith('chrome-extension://')) seen.push(new URL(e.url).pathname);
  });
  await cdp.send('Debugger.enable');
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(200);
  await cdp.detach();
  return seen;
}

test('no first-frame flash in 200 loads (cosmetic notes §2.3: ≤ 1 %, P1-34: 0)', async () => {
  test.setTimeout(120_000);
  const { context } = await start();
  const page = await context.newPage();
  const states: unknown[] = [];
  for (let i = 0; i < LOADS; i += 1) {
    await page.goto('https://cosmetic.example/cosmetic-specific/first-frame.html', { waitUntil: 'load' });
    // The first frame with the element may come after `load` on a busy machine: wait for its reading.
    states.push(await (await page.waitForFunction(() => (self as unknown as { __firstFrameDisplay?: string }).__firstFrameDisplay)).jsonValue());
  }
  const flashes = states.filter((s) => s !== 'none');
  test.info().annotations.push({ type: 'flash', description: `${String(flashes.length)} of ${String(LOADS)} first frames showed the element` });
  expect(flashes).toEqual([]);
});

test('zero scripts injected on a host without filters, top frame and every sub-frame (P1-34 gate)', async () => {
  const { context } = await start(ONE_PROCESS);
  const page = await context.newPage();
  const control = await extensionScripts(page, 'https://cosmetic.example/cosmetic-specific/host-match.html');
  expect(control).toContain('/cosmetic-specific.js');
  const none = await extensionScripts(page, 'https://unfiltered.example/cosmetic-specific/no-filters.html');
  expect(page.frames()).toHaveLength(4);
  expect(none).toEqual([]);
});

test('Off on a sub-host: excludeMatches holds in its about:blank child too (matchOriginAsFallback)', async () => {
  const fixture = 'https://sub.frames.example/cosmetic-specific/about-blank-frame.html';
  const { context, id, worker } = await start();
  const display = async (): Promise<unknown> => {
    const page = await context.newPage();
    await page.goto(fixture, { waitUntil: 'load' });
    const value = await page.evaluate(() => (self as unknown as { __frameAdDisplay?: string }).__frameAdDisplay);
    await page.close();
    return value;
  };
  expect(await display()).toBe('none');
  await applySettings(context, worker, id, { ...createDefaultSettings(), siteLevels: { 'sub.frames.example': 'off' } });
  const registered = await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).filter((s) => (s.excludeMatches ?? []).length > 0).map((s) => s.excludeMatches));
  expect(registered).toContainEqual(['*://*.sub.frames.example/*']);
  // After a level change Chrome may apply it to new loads a little later (`helpers/settle.ts`).
  await expect.poll(display, { timeout: PROPAGATION_WINDOW_MS, intervals: [250, 500, 1_000] }).toBe('block');
});

/** A data file for `example.test` with `SELECTORS` selectors, one of which Chrome refuses. */
function dataFile(): string {
  const selectors = Array.from({ length: SELECTORS }, (_, i) => (i === 1 ? '.b:unknown-pseudo' : `.s${String(i)}`)).sort();
  const datum = { v: 1, pack: 'ads', shard: 0, hosts: ['example.test'], entries: [{ h: selectors.map((_, i) => i) }], selectors, styles: [], procedural: [], invocations: [] };
  return `(self.__cs_q=self.__cs_q||[]).push(${JSON.stringify(datum)});`;
}

test('joined stylesheet: a refused rule does not swallow the others; applier time to adopted sheet', { tag: '@budget' }, async () => {
  test.setTimeout(120_000);
  const applier = await readFile(path.join(BUILD_DIR, 'cosmetic-specific.js'), 'utf8');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const body = '<!doctype html><title>t</title><div class="s0">0</div><div class="b">b</div><div class="s2">2</div><p class="s49">49</p>';
    await page.route('https://example.test/**', (route) => route.fulfill({ body, contentType: 'text/html' }));
    await page.addInitScript({ content: `{const t0=performance.now();${dataFile()}\n${applier}\nself.__adoptMs=performance.now()-t0;}` });
    const times: number[] = [];
    for (let i = 0; i < (PERF_RUN ? LOADS : CORRECTNESS_LOADS); i += 1) {
      await page.goto('https://example.test/');
      times.push(await page.evaluate(() => (self as unknown as { __adoptMs: number }).__adoptMs));
    }
    const shown = await page.evaluate(() => [...document.querySelectorAll('div,p')].map((e) => `${e.className}:${getComputedStyle(e).display}`));
    expect(shown).toEqual(['s0:none', 'b:block', 's2:none', 's49:none']);
    expect(await page.evaluate(() => document.adoptedStyleSheets[0]?.cssRules.length)).toBe(SELECTORS - 1);
    test.info().annotations.push({ type: 'adopt', description: `script start → sheet adopted, ${String(SELECTORS)} selectors: p50 ${pctl(times, 0.5).toFixed(2)} / p95 ${pctl(times, 0.95).toFixed(2)} ms (n=${String(LOADS)})` });
    expectBudget('script start → sheet adopted, p95 (ms)', pctl(times, 0.95), ADOPT_BUDGET_MS);
  } finally {
    await browser.close();
  }
});
