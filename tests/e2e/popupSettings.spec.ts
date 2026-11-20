/**
 * P2-54 in real Chromium: the pop-up commands from a settings page change what the worker installs, and
 * Chrome accepts the whole pop-up realm as `computeDesired` builds it from the packaged lists (redirects
 * included, which the build does not install until `blocked.html` ships, P2-55). Throwaway profile; no
 * web pages.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import type { Hostname } from '../../src/core/ids.js';
import { dynamicRealmOf } from '../../src/core/limits.js';
import { computeDesired, DEFAULT_DESIRED_LIMITS } from '../../src/core/reconcile/computeDesired.js';
import type { DnrRule } from '../../src/core/reconcile/types.js';
import { createDefaultSettings } from '../../src/core/state/defaults.js';
import type { Settings } from '../../src/core/state/types.js';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, extensionWorker, launch, newProfile } from './helpers/browser.js';
import { testCatalog } from '../unit/core/reconcile/fixtures.js';

const POLL = { timeout: 15_000, intervals: [100, 250, 500] };

const send = (page: Page, type: string, payload: unknown): Promise<unknown> =>
  page.evaluate(([t, p]) => chrome.runtime.sendMessage({ v: 1, type: t, id: `p${String(Date.now())}`, payload: p }), [type, payload] as const);
const realm = async (page: Page): Promise<DnrRule[]> =>
  (await page.evaluate(() => chrome.declarativeNetRequest.getDynamicRules()) as DnrRule[]).filter((r) => dynamicRealmOf(r.id) === 'popupDestinations');

async function settingsPage(): Promise<Page> {
  const context = await launch(await newProfile(), BUILD_DIR);
  const worker = await extensionWorker(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await expect.poll(() => send(page, 'c/reconcile', {}), POLL).toMatchObject({ ok: true });
  return page;
}

const hosts = async (file: string): Promise<Hostname[]> => JSON.parse(await readFile(path.join(BUILD_DIR, file), 'utf8')) as Hostname[];

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

test('pop-up commands: Allow adds the opener allow rule, inherit removes it; mode is accepted', async () => {
  const page = await settingsPage();
  expect(await send(page, 'c/setSitePopupPolicy', { hostname: 'shop.example', policy: 'allow' })).toMatchObject({ ok: true });
  // Allow rules only: since P2-55 the realm also holds the redirect rules to blocked.html (all-sites access).
  const allows = async () => (await realm(page)).filter((r) => r.action.type === 'allow').map((r) => r.condition.initiatorDomains);
  await expect.poll(allows, POLL).toEqual([['shop.example']]);
  expect(await send(page, 'c/setPopupMode', { mode: 'smart' })).toMatchObject({ ok: true });
  expect(await send(page, 'c/setSitePopupPolicy', { hostname: 'shop.example', policy: 'inherit' })).toMatchObject({ ok: true });
  await expect.poll(allows, POLL).toEqual([]);
  // The guard ships (P2-58): in Smart the sentinel and the shim run on every top-level document; the Strict
  // flag stays on the lists' Strict sites.
  const guard = (): Promise<unknown> => page.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts())
    .filter((s) => s.id.startsWith('popup-'))
    .map((s) => ({ id: s.id, everywhere: s.matches?.includes('<all_urls>') ?? false, allFrames: s.allFrames ?? false }))
    .sort((a, b) => a.id.localeCompare(b.id)));
  await expect.poll(guard, POLL).toEqual([
    { id: 'popup-sentinel', everywhere: true, allFrames: false },
    { id: 'popup-shim', everywhere: true, allFrames: false },
    { id: 'popup-strict', everywhere: false, allFrames: false },
  ]);
});

test('Chrome accepts the full pop-up realm built from the packaged lists', async () => {
  const page = await settingsPage();
  const popups = {
    destinations: await hosts('popup-destinations.json'),
    // D-55a: the lifted group too (5,000,000), so Chrome takes both redirect groups together.
    lifted: JSON.parse(await readFile(path.join(BUILD_DIR, 'popup-lifted.json'), 'utf8')) as Record<string, Hostname[]>,
    strictSites: await hosts('popup-strict-sites.json'),
    blockedPageUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/blocked.html',
    guardShipped: true,
    listStrict: true,
  };
  const many = Array.from({ length: 1_000 }, (_, i): [string, 'allow'] => [`allow${String(i)}.example`, 'allow']);
  const sites: Settings['popups']['sites'] = Object.fromEntries(many);
  const settings: Settings = { ...createDefaultSettings(), popups: { mode: 'smart', sites, notice: true } };
  const rules = computeDesired(settings, { origins: ['<all_urls>'] }, testCatalog(), 0, DEFAULT_DESIRED_LIMITS, { popups })
    .dynamicRules.filter((r) => dynamicRealmOf(r.id) === 'popupDestinations');
  expect(rules.filter((r) => r.action.type === 'redirect').length).toBeGreaterThan(0);

  const outcome = await page.evaluate(async (json) => {
    const addRules = JSON.parse(json) as chrome.declarativeNetRequest.Rule[];
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: addRules.map((r) => r.id), addRules });
      return (await chrome.declarativeNetRequest.getDynamicRules()).length;
    } catch (error) {
      return String(error);
    }
  }, JSON.stringify(rules));
  expect(outcome).toBe(rules.length);
});
