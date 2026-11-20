/**
 * J15 · the cosmetic appliers (`cosmetic-specific`, `user-cosmetic`) and the surveyors (procedural glue,
 * `cosmetic-generic` at Thorough) under a page that fights them: stylesheet tampering, DOM clobbering of
 * `document` and forms (also in an about:blank child), mutation floods, a huge DOM with unique class tokens,
 * shadow roots. Fail safe means: no exception on the page, the page keeps drawing frames, our sheets carry
 * nothing but hiding rules and sanitised `:style()` rules, and new ads are still hidden afterwards. Known
 * limits kept as such: page code can read or drop the sheets adopted into its own document, and stylesheets
 * do not reach into shadow roots (both as uBO Lite).
 */
import { loadavg } from 'node:os';
import { test, expect, type Page } from '@playwright/test';
import { createDefaultSettings } from '../../../src/core/state/defaults.js';
import { applySettings } from '../helpers/corpus.js';
import { call, expectNoExtensionNetwork, HOST, openHostile, SESSION_TIMEOUT_MS, startHostile, stopHostile, type Hostile } from './harness.js';

const FLOOD_MS = 2_000;
/** Frames a page must still draw over the flood (≈ 120 at 60 Hz): a bound against a hung tab, not a budget. */
const MIN_FLOOD_FRAMES = 10;
const HUGE_NODES = 50_000;
/** A bound against the old endless rescan, not a budget: 0.6 s measured at load 12 (P2-44). */
const HUGE_SURVEY_TIMEOUT_MS = 15_000;
const ALL_HIDDEN = { specific: true, procedural: true, generic: true, keep: false };

let h: Hostile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(SESSION_TIMEOUT_MS);
  h = await startHostile();
  // Thorough on the hostile host, so the generic surveyor runs there too (P2-25).
  await applySettings(h.context, h.worker, h.session.id, { ...createDefaultSettings(), siteLevels: { [HOST]: 'thorough' } });
});
test.afterAll(async () => { await stopHostile(); });

const errors = (tab: Page): Promise<unknown> => tab.evaluate(() => (window as unknown as { __errors: string[] }).__errors);

/** Every rule we adopted is a hiding rule or the sanitised `:style()` rule of the list. */
function expectOnlyOurRules(rules: readonly string[]): void {
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) expect(rule, rule).toMatch(/\{ (display: none !important;|position: static !important;) \}$/);
}

test('control: the hostile page is filtered at Thorough (specific, :style(), procedural, generic)', async () => {
  const tab = await openHostile(h, 'cosmetics');
  expect(await call(tab, '__fresh', 'control')).toEqual(ALL_HIDDEN);
  expect(await tab.locator('.sticky').evaluate((e) => getComputedStyle(e).position)).toBe('static');
  expectOnlyOurRules((await call(tab, '__sheetRules')) as string[]);
  expect(await errors(tab)).toEqual([]);
  await tab.close();
});

test('stylesheet tampering: rules the page inserts stay the page’s own; what it reads is hiding rules only', async () => {
  const tab = await openHostile(h, 'cosmetics');
  const rules = (await call(tab, '__sheetRules')) as string[];
  expectOnlyOurRules(rules);
  await call(tab, '__tamperSheets');
  // Dropping our sheets un-hides the ads (known limit, uBO Lite alike) and breaks nothing else.
  await call(tab, '__dropSheets');
  expect(await errors(tab)).toEqual([]);
  await tab.close();
});

test('DOM clobbering of document and form built-ins (here and in an about:blank child): no exception, new ads still hidden', async () => {
  const tab = await openHostile(h, 'cosmetics');
  await call(tab, '__clobber');
  expect(await call(tab, '__fresh', 'clobber')).toEqual(ALL_HIDDEN);
  expect(await errors(tab)).toEqual([]);
  await tab.close();
});

test('a mutation flood: the page keeps drawing, and ads added after it are hidden', async () => {
  const tab = await openHostile(h, 'cosmetics');
  const frames = (await call(tab, '__flood', FLOOD_MS)) as number;
  test.info().annotations.push({ type: 'flood', description: `${String(frames)} frames in ${String(FLOOD_MS)} ms at load ${loadavg()[0]?.toFixed(1) ?? '?'}` });
  expect(frames).toBeGreaterThanOrEqual(MIN_FLOOD_FRAMES);
  expect(await call(tab, '__fresh', 'flood')).toEqual(ALL_HIDDEN);
  expect(await errors(tab)).toEqual([]);
  await tab.close();
});

test('a huge DOM with unique class tokens and a 500-deep chain: no exception, ads added afterwards hidden', async () => {
  const tab = await openHostile(h, 'cosmetics');
  expect(await call(tab, '__huge', HUGE_NODES)).toBeGreaterThan(HUGE_NODES);
  expect(await call(tab, '__fresh', 'huge')).toEqual(ALL_HIDDEN);
  expect(await errors(tab)).toEqual([]);
  await tab.close();
});

/**
 * The same huge DOM built before the surveyor's first survey (P2-44): more classed elements than its queue
 * bound once made it restart on the root forever, so nothing was hidden (the timing flake of the test above,
 * which hit it whenever `document_idle` came after `__huge` under load).
 */
test('a huge DOM present at document_idle: the generic surveyor still gets through it', async () => {
  const tab = await h.context.newPage();
  await tab.goto(`https://${HOST}/hostile/cosmetics.html#huge-at-load`, { waitUntil: 'load' });
  await expect(tab.locator('.generic-ad').first()).toBeHidden({ timeout: HUGE_SURVEY_TIMEOUT_MS });
  expect(await call(tab, '__fresh', 'huge-at-load')).toEqual(ALL_HIDDEN);
  expect(await errors(tab)).toEqual([]);
  await tab.close();
});

test('ads inside open and closed shadow roots: no exception, the light DOM stays filtered', async () => {
  const tab = await openHostile(h, 'cosmetics');
  await call(tab, '__shadow');
  expect(await call(tab, '__fresh', 'shadow')).toEqual(ALL_HIDDEN);
  expect(await errors(tab)).toEqual([]);
  await tab.close();
});

test('J16 row: no extension-initiated request during the cosmetic probes', () => {
  expectNoExtensionNetwork(h);
});
