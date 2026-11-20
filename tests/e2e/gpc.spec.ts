/**
 * P2-31 in real Chromium: with GPC on, a page gets `Sec-GPC: 1` on its requests and sees
 * `navigator.globalPrivacyControl === true`; with GPC off, neither. Local fixture server on 127.0.0.1
 * that records the header; throwaway profile.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, extensionWorker, launch, newProfile } from './helpers/browser.js';

const POLL = { timeout: 15_000, intervals: [100, 250, 500] };
/** Two reconciles with the real registration set (≈ 3–8 s each under load). */
const GPC_TEST_TIMEOUT_MS = 90_000;
let seen: (string | undefined)[] = [];
let server: http.Server;
let origin = '';

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const value = req.headers['sec-gpc'];
    seen = [...seen, Array.isArray(value) ? value.join(',') : value];
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<!doctype html><title>gpc</title><p>gpc</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await expectNoSurvivors();
});

const send = (page: Page, type: string, payload: unknown): Promise<unknown> =>
  page.evaluate(([t, p]) => chrome.runtime.sendMessage({ v: 1, type: t, id: `g${String(Date.now())}`, payload: p }), [type, payload] as const);

/**
 * One visit; a navigation Chrome aborts while it is still applying a ruleset change (seen under load) counts
 * as not yet, so callers poll: the state is eventually consistent, not instant.
 */
async function visit(context: BrowserContext): Promise<{ header: string | undefined; property: unknown }> {
  seen = [];
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/`);
    const property = await page.evaluate(() => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl);
    return { header: seen.at(-1), property };
  } catch {
    return { header: 'navigation aborted', property: 'navigation aborted' };
  } finally {
    await page.close();
  }
}

test('P2-31: header and property present only while GPC is on', async () => {
  test.setTimeout(GPC_TEST_TIMEOUT_MS);
  const context = await launch(await newProfile(), BUILD_DIR);
  const worker = await extensionWorker(context);
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  await expect.poll(() => send(settings, 'c/reconcile', {}), POLL).toMatchObject({ ok: true });

  expect(await visit(context)).toEqual({ header: undefined, property: undefined });
  expect(await send(settings, 'c/setGpc', { enabled: true })).toMatchObject({ ok: true });
  expect(await settings.evaluate(async () => (await chrome.declarativeNetRequest.getEnabledRulesets()).includes('gpc-x'))).toBe(true);
  await expect.poll(() => visit(context), POLL).toEqual({ header: '1', property: true });
  expect(await send(settings, 'c/setGpc', { enabled: false })).toMatchObject({ ok: true });
  await expect.poll(() => visit(context), POLL).toEqual({ header: undefined, property: undefined });
});
