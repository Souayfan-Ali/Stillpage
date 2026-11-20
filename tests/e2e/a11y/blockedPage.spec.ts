/**
 * P2-39: the blocked page (UI notes §9: a real page with a heading, focus on the primary button, native
 * buttons only) on the real build, opened directly with a fragment: an existing tab (Go back first), a fresh
 * tab (Close tab first) and a hostile fragment (no host). axe 0 in light, dark and the manual theme override;
 * keyboard only: Enter on the focused primary button, Tab to "Proceed once" and Enter (the worker accepts a key
 * press as the user's own activation). The listed host is answered by a route; nothing reaches the network.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { test } from '../fixtures.js';
import { BUILD_DIR } from '../helpers/fixtureExtension.js';
import { expectAccessible, expectThemeOverrides } from '../helpers/settingsPages.js';

/** "Proceed once" needs a listed destination (the worker checks); one from the build, answered by a route, never fetched. */
const HOST = (JSON.parse(readFileSync(path.join(BUILD_DIR, 'popup-destinations.json'), 'utf8')) as string[]).find((h) => /^[a-z][a-z0-9-]*\.[a-z]+$/.test(h)) ?? '';
const LISTED = `https://${HOST}/landing?x=1`;

async function routeListed(context: BrowserContext): Promise<void> {
  await context.route(`https://${HOST}/**`, (route) => route.fulfill({ body: '<!doctype html><title>landed</title><p>landed</p>', contentType: 'text/html' }));
}

async function shown(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'This page was blocked' })).toBeVisible();
}

test('existing tab: Go back has focus, axe 0, Enter goes back', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html?tabId=1`);
  const before = page.url();
  await page.goto(`chrome-extension://${extensionId}/blocked.html#${LISTED}`);
  await shown(page);
  await expect(page.getByRole('button', { name: 'Go back' })).toBeFocused();
  await expectAccessible(page);
  await expectThemeOverrides(page);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.url()).toBe(before);
});

test('fresh tab: Close tab has focus, axe 0; keyboard only, Proceed once is accepted for that tab', async ({ context, serviceWorker, extensionId }) => {
  await routeListed(context);
  const opened = context.waitForEvent('page');
  await serviceWorker.evaluate(async (url) => { await chrome.tabs.create({ url }); }, `chrome-extension://${extensionId}/blocked.html#${LISTED}`);
  const page = await opened;
  await shown(page);
  await expect(page.locator('.actions button')).toHaveText(['Close tab']);
  await expect(page.locator('.proceed button.link')).toHaveText('Proceed once');
  await expect(page.getByRole('button', { name: 'Close tab' })).toBeFocused();
  await expectAccessible(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Proceed once' })).toBeFocused();
  await page.keyboard.press('Enter');
  // A key press is a real activation: the worker added the tab's allow rule (where the tab then goes is J18's).
  await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.condition.requestDomains)), { timeout: 15_000 }).toEqual([[HOST]]);
});

test('hostile fragment: no host, focus on the only button, axe 0', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/blocked.html#javascript:alert(1)`);
  await shown(page);
  await expect(page.getByRole('button', { name: /Go back|Close tab/ }).first()).toBeFocused();
  await expectAccessible(page);
});
