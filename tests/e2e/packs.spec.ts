/**
 * J11 (P2-26, testing notes §4): enable and disable packs on the real build; capacity exceeded gives an honest
 * error. The capacity rows copy the build and raise one pack's catalog ceiling past what Chrome reports
 * as available (`getAvailableStaticRuleCount`), or its regex ceiling past the pool, so the real API path
 * decides without filling the profile-wide pool. Throwaway profiles; no web pages.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { BUILD_DIR, TEMP_PREFIX } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, extensionWorker, launch, newProfile } from './helpers/browser.js';

/** Far above guaranteed 30,000 + global 300,000. */
const HUGE_CEILING = 400_000;
const POLL = { timeout: 15_000, intervals: [100, 250, 500] };
/** Since P2-27 the cookie pack registers its real shards (345 registrations, ≈ 27,000 patterns): persisting them takes seconds. */
const PACK_TEST_TIMEOUT_MS = 90_000;
test.setTimeout(PACK_TEST_TIMEOUT_MS);

interface Catalog {
  rulesets: Record<string, { maxRules: number; maxRegex: number }>;
}

async function copyWith(change: (catalog: Catalog) => void): Promise<{ dir: string; remove: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  const dir = path.join(root, 'ext');
  await cp(BUILD_DIR, dir, { recursive: true });
  const file = path.join(dir, 'catalog.json');
  const catalog = JSON.parse(await readFile(file, 'utf8')) as Catalog;
  change(catalog);
  await writeFile(file, JSON.stringify(catalog));
  return { dir, remove: () => rm(root, { recursive: true, force: true }) };
}

async function openSettingsPage(context: BrowserContext): Promise<Page> {
  const worker = await extensionWorker(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  return page;
}

function send(page: Page, type: string, payload: unknown): Promise<unknown> {
  return page.evaluate(
    ([t, p]) => chrome.runtime.sendMessage({ v: 1, type: t, id: `j11${String(Date.now())}`, payload: p }),
    [type, payload] as const,
  );
}

const enabled = (page: Page): Promise<string[]> => page.evaluate(async () => (await chrome.declarativeNetRequest.getEnabledRulesets()).sort());
const settled = async (page: Page): Promise<void> => {
  await expect.poll(() => send(page, 'c/reconcile', {}), POLL).toMatchObject({ ok: true });
};

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

test('J11: enabling and disabling a pack switches its rulesets', async () => {
  const context = await launch(await newProfile(), BUILD_DIR);
  const page = await openSettingsPage(context);
  await settled(page);
  expect(await enabled(page)).not.toContain('cookies');

  expect(await send(page, 'c/setPack', { pack: 'cookies', enabled: true })).toMatchObject({ ok: true, data: { skippedPacks: [] } });
  expect(await enabled(page)).toEqual(expect.arrayContaining(['cookies', 'cookies-x', 'ubo']));

  expect(await send(page, 'c/setPack', { pack: 'cookies', enabled: false })).toMatchObject({ ok: true });
  expect(await enabled(page)).not.toContain('cookies');
  expect(await send(page, 'c/setPack', { pack: 'popups', enabled: false })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
});

test('J11: a pack that does not fit the rule pool or the regex pool is refused honestly', async () => {
  const fixture = await copyWith((c) => {
    const { cookies, 'reg-de': regDe } = c.rulesets;
    if (cookies === undefined || regDe === undefined) throw new Error('build lacks the cookies or reg-de slot');
    cookies.maxRules = HUGE_CEILING;
    regDe.maxRegex = 1_000;
  });
  try {
    const context = await launch(await newProfile(), fixture.dir);
    const page = await openSettingsPage(context);
    await settled(page);
    const before = await enabled(page);
    const available = await page.evaluate(() => chrome.declarativeNetRequest.getAvailableStaticRuleCount());

    const rules = await send(page, 'c/setPack', { pack: 'cookies', enabled: true });
    expect(rules).toMatchObject({ ok: false, error: { code: 'no-capacity', detail: { reason: 'rule-pool', available } } });
    const regex = await send(page, 'c/setPack', { pack: 'reg-de', enabled: true });
    // reg-de's safe slot raised to 1,000 regex, plus its `-x` slot's 10 (P2-29 split).
    expect(regex).toMatchObject({ ok: false, error: { code: 'no-capacity', detail: { reason: 'regex-pool', needed: 1_010 } } });

    expect(await enabled(page)).toEqual(before);
    expect(await send(page, 'c/setPack', { pack: 'annoy-social', enabled: true })).toMatchObject({ ok: true });
  } finally {
    await closeAll();
    await fixture.remove();
  }
});
