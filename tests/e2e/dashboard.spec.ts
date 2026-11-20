/**
 * Dashboard shell and Protection (P2-34) on the real build: the options page, axe in light and dark,
 * a pack toggled from its checkbox (rulesets follow, the Thorough offer works), the default level
 * changed keyboard-only, and an honest inline error when a pack does not fit (copy of the build with
 * a cookies ceiling far above Chrome's pool, as J11 does). Throwaway profiles; no web pages.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BUILD_DIR, TEMP_PREFIX } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, launch, newProfile } from './helpers/browser.js';
import { enabledRulesets, expectAccessible, openPage, POLL, send, settled } from './helpers/settingsPages.js';

/** Enabling cookies persists its real shard registrations (seconds under load, J11). */
test.setTimeout(240_000);
const PACK_RUN_MS = 150_000;

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

/**
 * UI notes §8: dashboard JS ≤ 90 kB gzip initial (its module script plus every module it preloads).
 * Here until `.size-limit.json` adopts the line (design review, P2-34); fails, never skips,
 * when the build is missing.
 */
const DASHBOARD_JS_GZIP_BUDGET = 90_000;

test('dashboard initial JS is within 90 kB gzip', async () => {
  const html = await readFile(path.join(BUILD_DIR, 'dashboard.html'), 'utf8');
  const files = [...html.matchAll(/<(?:script type="module"[^>]*src|link rel="modulepreload"[^>]*href)="\/([^"]+\.js)"/g)].map((m) => m[1] ?? '');
  expect(files.length).toBeGreaterThan(0);
  const sizes = await Promise.all(files.map(async (file) => gzipSync(await readFile(path.join(BUILD_DIR, file))).length));
  expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(DASHBOARD_JS_GZIP_BUDGET);
});

/** D-47: above 27 kB gzip the worker bundle gets a warning annotation; it never fails the run. */
const WORKER_WARN_GZIP = 27_000;

test('worker bundle: warns above 27 kB gzip (D-47, non-blocking)', async () => {
  const size = gzipSync(await readFile(path.join(BUILD_DIR, 'background.js'))).length;
  if (size > WORKER_WARN_GZIP) {
    test.info().annotations.push({ type: 'warning', description: `worker ${String(size)} B gzip is above the 27 kB warning line (D-47)` });
  }
  expect(size).toBeGreaterThan(0);
});

test('the dashboard is the options page', async () => {
  const manifest = JSON.parse(await readFile(path.join(BUILD_DIR, 'manifest.json'), 'utf8')) as { options_ui?: unknown };
  expect(manifest.options_ui).toEqual({ page: 'dashboard.html', open_in_tab: true });
});

test('Protection: accessible, packs toggle from the page, Thorough offer, keyboard-only level', async () => {
  const context = await launch(await newProfile(), BUILD_DIR);
  const page = await openPage(context, 'dashboard.html');
  await settled(page);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Protection' })).toBeVisible();
  await expect(page.getByText(/rules Chrome guarantees\./)).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('checkbox', { name: 'Cookie banners' }).check();
  // The command answers after the run that persists the pack's shards (tens of seconds under load).
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible({ timeout: PACK_RUN_MS });
  expect(await enabledRulesets(page)).toContain('cookies');
  await page.getByRole('button', { name: 'Use Thorough' }).click();
  await expect(page.getByLabel('Thorough')).toBeChecked({ timeout: POLL.timeout });
  await expectAccessible(page);

  // Keyboard only: focus the checked level radio, then arrow to the next one.
  await page.getByLabel('Thorough').focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByLabel('Standard')).toBeChecked({ timeout: POLL.timeout });
  await expect.poll(async () => ((await send(page, 'q/dashboard', {})) as { data: { settings: { defaultLevel: string } } }).data.settings.defaultLevel, POLL).toBe('standard');
});

test('a pack that does not fit: inline alert, checkbox stays off, rulesets unchanged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  const dir = path.join(root, 'ext');
  try {
    await cp(BUILD_DIR, dir, { recursive: true });
    const file = path.join(dir, 'catalog.json');
    const catalog = JSON.parse(await readFile(file, 'utf8')) as { rulesets: Record<string, { maxRules: number }> };
    const cookies = catalog.rulesets['cookies'];
    if (cookies === undefined) throw new Error('build lacks the cookies slot');
    cookies.maxRules = 400_000;
    await writeFile(file, JSON.stringify(catalog));
    const context = await launch(await newProfile(), dir);
    const page = await openPage(context, 'dashboard.html');
    await settled(page);
    await page.reload();
    const before = await enabledRulesets(page);
    await page.getByRole('checkbox', { name: 'Cookie banners' }).check();
    await expect(page.getByRole('alert')).toContainText('Not enough room. This pack needs up to 400,');
    await expect(page.getByRole('checkbox', { name: 'Cookie banners' })).not.toBeChecked();
    expect(await enabledRulesets(page)).toEqual(before);
    await expectAccessible(page);
  } finally {
    await closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
