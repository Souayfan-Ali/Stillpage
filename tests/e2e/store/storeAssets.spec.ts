/**
 * Store listing assets (P2-50, store notes §3): icon, promo tile and screenshots, made from the real build's
 * pages in bundled Chromium on local fixtures (`.example` hosts, invented content; nothing contacts the
 * web). The corpus copy carries the fixture rulesets and, for real counts in the privacy panel, the
 * test-only feedback patch (`helpers/feedbackCopy.ts`). Runs only on demand: `npm run store:assets`
 * (it writes into `store/`); a normal E2E run skips it.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { PRODUCT_NAME } from '../../../src/core/brand.js';
import { loadFixtures } from '../../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server/server.js';
import { nonLoopbackPeers } from '../../fixtures/server/sockets.js';
import { closeAll, expectNoSurvivors, extensionWorker, launch, newProfile, removeProfile } from '../helpers/browser.js';
import { createCorpusExtension, type CorpusExtension } from '../helpers/corpus.js';
import { patchForMatchedRules } from '../helpers/feedbackCopy.js';
import { openPanel, startSession, tabIdOf, type Session } from '../helpers/session.js';

const ENABLED = process.env['GLASSMERE_STORE_ASSETS'] === '1';
const STORE = path.resolve(import.meta.dirname, '../../../store');
const SHOTS = path.join(STORE, 'screenshots');
const VIEW = { width: 1280, height: 800 } as const;
/** Short, so a full-page screenshot is as tall as the panel's content. */
const PANEL_VIEW = { width: 360, height: 120 } as const;
const ICON_SIZES = [16, 32, 48, 128] as const;
const PROMO = { width: 440, height: 280 } as const;
const STORY_URL = 'https://news.example/store/story.html';
const ASSET_TIMEOUT_MS = 180_000;

/** An invented article page; the ad script is a fixture host the fixture ruleset blocks. */
const STORY = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The quiet harbour</title>
<style>body{margin:0;font:18px/1.6 Georgia,serif;color:#1f2933;background:#fbfaf7}
header{padding:20px 48px;border-bottom:1px solid #e4e0d8;font:600 20px system-ui,sans-serif}
main{max-width:720px;margin:32px 48px}h1{font-size:36px;line-height:1.2;margin:0 0 16px}
.slot{width:300px;height:250px;margin:24px 0;border:1px dashed #c9c3b8;display:grid;place-items:center;color:#9a9185;font:14px system-ui,sans-serif}</style></head>
<body><header>Harbour Weekly</header><main><h1>The quiet harbour</h1>
<p>Morning fog lifts slowly over the water. The boats have not left yet, and the gulls wait on the posts.</p>
<div class="slot" id="promo">Sponsored</div>
<p>By noon the market is busy. Nets are mended, crates are stacked, and someone is always telling the
story of the storm of last winter, a little bigger every year.</p>
<p>In the evening the light turns gold and the harbour goes still again.</p></main>
<script src="https://ads.example/ad.js"></script></body></html>`;

test.skip(!ENABLED, 'store assets are made on demand: npm run store:assets');
test.setTimeout(ASSET_TIMEOUT_MS);

const dataUrl = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`;

test('icon and promo tile from store/icon/icon.svg', async ({ page }) => {
  const svg = `data:image/svg+xml;base64,${(await readFile(path.join(STORE, 'icon', 'icon.svg'))).toString('base64')}`;
  for (const size of ICON_SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0"><img src="${svg}" width="${String(size)}" height="${String(size)}" style="display:block">`);
    await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());
    await page.screenshot({ path: path.join(STORE, 'icon', `icon-${String(size)}.png`), omitBackground: true });
  }
  await page.setViewportSize(PROMO);
  await page.setContent(`<body style="margin:0;width:440px;height:280px;background:#0e5e5a;display:flex;align-items:center;gap:28px;padding:0 40px;box-sizing:border-box;font-family:system-ui,sans-serif;color:#fff">
    <img src="${svg}" width="112" height="112" style="flex:none;border-radius:24px;box-shadow:0 0 0 2px #ffffff33">
    <div><div style="font-size:40px;font-weight:650;letter-spacing:-0.5px">${PRODUCT_NAME}</div>
    <div style="font-size:18px;line-height:1.35;margin-top:8px;opacity:.92">Blocks ads and trackers quietly.</div></div></body>`);
  await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());
  await page.screenshot({ path: path.join(STORE, 'promo-tile-440x280.png') });
});

/** The page screenshot behind, the extension page in front at the top right, as Chrome shows the panel. */
async function compose(context: BrowserContext, background: Buffer, front: Buffer, file: string): Promise<void> {
  const page = await context.newPage();
  await page.setViewportSize(VIEW);
  await page.setContent(`<body style="margin:0;width:1280px;height:800px;overflow:hidden;position:relative;background:#fff">
    <img src="${dataUrl(background)}" style="position:absolute;inset:0;width:1280px;height:800px">
    <img src="${dataUrl(front)}" style="position:absolute;top:12px;right:24px;max-height:776px;border-radius:8px;box-shadow:0 12px 40px #0004,0 0 0 1px #0002"></body>`);
  await page.locator('img').nth(1).evaluate((img: HTMLImageElement) => img.decode());
  await page.screenshot({ path: path.join(SHOTS, file) });
  await page.close();
}

async function openStory(s: Session): Promise<{ page: Page; tabId: number }> {
  await s.context.route(STORY_URL, (route) => route.fulfill({ body: STORY, contentType: 'text/html' }));
  const page = await s.context.newPage();
  await page.setViewportSize(VIEW);
  const blocked = page.waitForEvent('requestfailed', (r) => r.url() === 'https://ads.example/ad.js');
  await page.goto(STORY_URL);
  await blocked;
  return { page, tabId: await tabIdOf(s.probe.page, STORY_URL) };
}

async function panelShot(panel: Page): Promise<Buffer> {
  await panel.setViewportSize(PANEL_VIEW);
  return panel.screenshot({ fullPage: true });
}

/** What the worker does on `c/startPicker` (as in `tests/e2e/picker.spec.ts`), then a pick on the ad slot. */
async function hideElementShot(s: Session, story: Page): Promise<void> {
  await s.worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    const tabId = tab?.id ?? -1;
    const nonce = 'storeAssetsNonce_0123456';
    await chrome.storage.session.set({ [`picker:${nonce}`]: { tabId, hostname: 'news.example', mode: 'hide', createdAt: Date.now(), claimed: false } });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['picker.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'x/pickerStart', nonce, mode: 'hide' }, { frameId: 0 });
  }, STORY_URL);
  await story.bringToFront();
  const box = await story.locator('#promo').boundingBox();
  if (box === null) throw new Error('ad slot not laid out');
  await story.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await story.keyboard.press('Enter');
  await expect.poll(() => story.frames().some((f) => f.url().includes('picker-panel.html'))).toBe(true);
  const frame = story.frames().find((f) => f.url().includes('picker-panel.html'));
  await frame?.locator('[role="dialog"]').waitFor();
  // Without the live preview the picked box stays in place under its highlight.
  await frame?.locator('input[type="checkbox"]').uncheck();
  await story.screenshot({ path: path.join(SHOTS, '4-hide-element.png') });
}

/** The dashboard of the build itself (not the corpus copy), so the real packs show. */
async function dashboardShot(): Promise<void> {
  const profile = await newProfile();
  const context = await launch(profile, path.resolve(import.meta.dirname, '../../../.output/chrome-mv3'));
  try {
    const id = new URL((await extensionWorker(context)).url()).host;
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize(VIEW);
    await page.goto(`chrome-extension://${id}/dashboard.html`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, '5-dashboard-dark.png') });
  } finally {
    await context.close();
    await removeProfile(profile);
  }
}

test('screenshots from the build on local fixtures', async () => {
  const server: FixtureServer = await startFixtureServer();
  const extension: CorpusExtension = await createCorpusExtension(loadFixtures());
  const contexts = new Set<BrowserContext>();
  try {
    await patchForMatchedRules(extension.dir);
    const s = await startSession(server, extension.dir, contexts);
    const story = await openStory(s);
    const background = await story.page.screenshot();

    const panel = await openPanel(s, story.tabId);
    const card = panel.getByRole('button', { name: /blocked on this page/ });
    await expect(card).toBeVisible();
    await compose(s.context, background, await panelShot(panel), '1-panel.png');
    await card.click();
    await expect(panel.getByRole('heading', { name: /What was blocked on news\.example/ })).toBeVisible();
    await compose(s.context, background, await panelShot(panel), '2-what-was-blocked.png');

    const flow = await openPanel(s, story.tabId);
    await flow.getByRole('button', { name: 'Something wrong with this page?' }).click();
    await expect(flow.getByRole('heading', { name: 'Fix this page' })).toBeVisible();
    await compose(s.context, background, await panelShot(flow), '3-fix-this-page.png');

    await hideElementShot(s, story.page);
    expect(nonLoopbackPeers(s.profile)).toEqual([]);
  } finally {
    await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
    await closeAll();
    await server.close();
    await extension.remove();
    await expectNoSurvivors();
  }
  await dashboardShot();
});
