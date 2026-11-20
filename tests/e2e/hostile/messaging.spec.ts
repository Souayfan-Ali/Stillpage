/**
 * J15 · the page against the extension's doors (security notes §9): no messaging API in a web page, every known
 * message type posted every way a page can post it changes nothing, and no packaged file can be loaded by its
 * static address (the web-accessible pages are `use_dynamic_url`, everything else is not web-accessible).
 */
import { test, expect } from '@playwright/test';
import { expectNoExtensionNetwork, openHostile, SESSION_TIMEOUT_MS, startHostile, stopHostile, type Hostile } from './harness.js';

const FILES = ['manifest.json', 'background.js', 'catalog.json', 'picker.js', 'popup-sentinel.js', 'popup.html', 'picker-panel.html', 'blocked.html', 'fx.html'];
const SETTLE_MS = 1_000;

let h: Hostile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(SESSION_TIMEOUT_MS);
  h = await startHostile();
});
test.afterAll(async () => { await stopHostile(); });

/** What the worker holds that a message could change. */
const state = (): Promise<unknown> => h.worker.evaluate(async () => ({
  local: Object.keys(await chrome.storage.local.get(null)).filter((k) => k !== 'e2e.boots').sort(),
  session: Object.keys(await chrome.storage.session.get(null)).filter((k) => !k.startsWith('reconcile')).sort(),
  dynamic: (await chrome.declarativeNetRequest.getDynamicRules()).length,
  sessionRules: (await chrome.declarativeNetRequest.getSessionRules()).length,
  scripts: (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).sort(),
}));

test('a web page has no messaging API; every known message, posted and dispatched, changes nothing', async () => {
  const tab = await openHostile(h, 'messaging');
  expect(await tab.evaluate(() => (window as unknown as { __api: () => object }).__api())).toMatchObject({ runtime: 'undefined', sendMessage: 'undefined', connect: 'undefined' });
  const before = await state();
  const children = await tab.evaluate(() => document.documentElement.children.length);
  await tab.evaluate((id) => (window as unknown as { __post: (i: string) => number }).__post(id), h.session.id);
  await tab.waitForTimeout(SETTLE_MS);
  expect(await state()).toEqual(before);
  expect(await tab.evaluate(() => document.documentElement.children.length)).toBe(children);
  expect(await tab.evaluate(() => (window as unknown as { __errors: string[] }).__errors)).toEqual([]);
  await tab.close();
});

test('no packaged file loads from a web page by its static address, even with the real id', async () => {
  const tab = await openHostile(h, 'messaging');
  for (const file of FILES) {
    const ways = await tab.evaluate((url) => (window as unknown as { __load: (u: string) => Promise<string[]> }).__load(url), `chrome-extension://${h.session.id}/${file}`);
    expect(ways, file).toEqual([]);
  }
  await tab.close();
});

test('J16 row: no extension-initiated request during the messaging probes', () => {
  expectNoExtensionNetwork(h);
});
