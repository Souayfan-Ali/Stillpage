/**
 * J19, the toolbar panel's pop-up row (P2-60b, testing notes §6), keyboard only, on the real build with the sentinel
 * registered by the test on a site where the default mode `off` registers none:
 * - the page's count and list come from its sentinel; "Open" opens the host in a new tab; a page without a
 *   sentinel says it is not running while blocking should run there (Smart, or Strict on the site), and says
 *   nothing while pop-ups are Off (D-107, D-114);
 * - "Allowed" from the row stores the site policy and installs the opener `allow` rule, as `computeDesired` says;
 *   Strict is offered, since the guard ships (P2-58);
 * - the dashboard's "Tell me when a pop-up is blocked" stores the choice.
 * The browser restart and the hostile-notice steps of J19 are `dashboardPopups.spec.ts` and `journeyPopupControls.spec.ts`.
 */
import { expect } from '@playwright/test';
import { dynamicRealmOf } from '../../src/core/limits.js';
import { test } from './fixtures.js';
import { GUARD_HOST, openPanelFor, pageWithBlockedPopup, press, sitePolicy, tabTo } from './helpers/guardPage.js';

const NOT_RUNNING = 'Pop-up blocking is not running on this page. Reloading the page may start it.';

test.beforeEach(() => {
  test.setTimeout(120_000);
});

test('J19 row count and list from the page sentinel; Open opens the host; keyboard only', async ({ context, serviceWorker, extensionId }) => {
  const { tabId } = await pageWithBlockedPopup(context, serviceWorker);
  const p = await openPanelFor(context, extensionId, tabId);
  await press(p, '1 blocked here');
  await expect(p.getByRole('button', { name: '1 blocked here' })).toHaveAttribute('aria-expanded', 'true');
  const opened = context.waitForEvent('request', (request) => request.url() === 'https://ads.example/' && request.isNavigationRequest());
  await press(p, 'Open ads.example');
  expect((await opened).frame().page()).not.toBe(p);
  await expect(p.getByText('Opened in a new tab.')).toBeVisible();
});

test('J19 Allowed from the row, keyboard only: stored, and the opener allow rule is in Chrome; Strict offered with the guard shipped', async ({ context, serviceWorker, extensionId }) => {
  const { tabId } = await pageWithBlockedPopup(context, serviceWorker);
  const p = await openPanelFor(context, extensionId, tabId);
  const select = p.getByRole('combobox', { name: 'Pop-ups on this site' });
  await expect(select.locator('option[value="strict"]')).toBeEnabled();
  await tabTo(p, 'Pop-ups on this site', 'combobox');
  await p.keyboard.press('ArrowDown');
  await expect(select).toHaveValue('allow');
  await expect.poll(() => sitePolicy(p)).toBe('allow');
  const openerRules = (): Promise<unknown> => p.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => ({ id: r.id, type: r.action.type, initiators: r.condition.initiatorDomains ?? [] })));
  await expect.poll(async () => ((await openerRules()) as { id: number; type: string; initiators: string[] }[]).some((r) => dynamicRealmOf(r.id) === 'popupDestinations' && r.type === 'allow' && r.initiators.includes(GUARD_HOST))).toBe(true);
  await expect(p.getByText('Saved. Reload the page to apply it.')).toBeVisible();
});

test('J19 a page without a sentinel: no note while pop-ups are Off (D-107); Strict chosen in the row, or Smart, says it is not running and a reload may start it (D-114)', async ({ context, serviceWorker, extensionId }) => {
  await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] !== undefined), { timeout: 60_000 }).toBe(true);
  await context.route('https://plain.example/**', (route) => route.fulfill({ body: '<title>plain</title><p>plain</p>', contentType: 'text/html' }));
  const page = await context.newPage();
  await page.goto('https://plain.example/');
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({ url: 'https://plain.example/*' }))[0]?.id ?? -1);
  const p = await openPanelFor(context, extensionId, tabId, 'plain.example');
  await expect(p.getByRole('combobox', { name: 'Pop-ups on this site' })).toBeVisible();
  await expect(p.getByText(NOT_RUNNING)).toHaveCount(0);
  // D-114: Strict chosen in the row on a page loaded without a sentinel: the note and the saved line agree.
  await p.getByRole('combobox', { name: 'Pop-ups on this site' }).selectOption('strict');
  await expect(p.getByText('Saved. Reload the page to apply it.')).toBeVisible();
  await expect(p.getByText(NOT_RUNNING)).toBeVisible();
  // Smart: blocking should run on every page, so a page that loaded without a sentinel says it is not running.
  expect(await p.evaluate(() => chrome.runtime.sendMessage({ v: 1, type: 'c/setPopupMode', id: 'j19', payload: { mode: 'smart' } }))).toMatchObject({ ok: true });
  await p.reload();
  await expect(p.getByText(NOT_RUNNING)).toBeVisible();
});

test('J19 dashboard: "Tell me when a pop-up is blocked", keyboard only, stores the choice', async ({ context, extensionId }) => {
  const dash = await context.newPage();
  await dash.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await tabTo(dash, 'Tell me when a pop-up is blocked', 'checkbox', 60);
  await expect(dash.getByRole('checkbox', { name: 'Tell me when a pop-up is blocked' })).toBeChecked();
  await dash.keyboard.press('Space');
  const notice = (): Promise<unknown> => dash.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('vault', 1);
      req.onsuccess = () => { resolve(req.result); };
    });
    const value = await new Promise<unknown>((resolve) => {
      const req = db.transaction('kv').objectStore('kv').get('settings');
      req.onsuccess = () => { resolve(req.result); };
    });
    db.close();
    return (value as { popups?: { notice?: boolean } } | undefined)?.popups?.notice ?? null;
  });
  await expect.poll(notice).toBe(false);
});
