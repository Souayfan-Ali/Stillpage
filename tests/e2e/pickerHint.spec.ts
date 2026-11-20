/**
 * P3-17 item 2: "Hide element" from the context menu pre-picks the right-clicked element. D-61's method:
 * the worker's real `contextMenus.onClicked` listener is fired with `dispatch(info, tab)`, here with the
 * `srcUrl` of an image and the `frameUrl` of a sub-frame (local routed fixtures only). The picker panel
 * opens on that element without a click; a hint that matches nothing leaves the picker waiting as before.
 */
import { expect, type BrowserContext, type Frame, type Page, type Worker } from '@playwright/test';
import { test } from './fixtures.js';
import { overlayOpen } from './helpers/hider.js';

const ORIGIN = 'https://hint.example';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const PAGE = `<!doctype html><title>hint</title><style>body{margin:0}img,iframe,p{display:block;width:300px;height:120px;margin:20px}</style>
<p id="keep">keep</p><img id="pic" src="/pic.png" alt=""><iframe id="frm" src="/frame.html" title="ad"></iframe>`;

async function openHintPage(context: BrowserContext): Promise<Page> {
  await context.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pic.png') return route.fulfill({ body: PNG, contentType: 'image/png' });
    if (path === '/frame.html') return route.fulfill({ body: '<!doctype html><p>frame</p>', contentType: 'text/html' });
    return route.fulfill({ body: PAGE, contentType: 'text/html' });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  await page.bringToFront();
  return page;
}

/** Fires the real "Hide element" listener with `info` for the fixture tab. */
async function rightClick(sw: Worker, info: Record<string, unknown>): Promise<void> {
  await sw.evaluate(async ({ origin, extra }) => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
    const data = { menuItemId: 'hide-element', editable: false, pageUrl: tab?.url, frameId: 0, ...extra } as unknown as chrome.contextMenus.OnClickData;
    (chrome.contextMenus.onClicked as unknown as { dispatch: (i: unknown, tb: unknown) => void }).dispatch(data, { id: tab?.id, url: tab?.url });
  }, { origin: ORIGIN, extra: info });
}

const panelFrame = (page: Page): Frame | undefined => page.frames().find((f) => f.url().includes('picker-panel.html'));

/** The panel opened on its own with `selector` as the offered candidate. */
async function expectPicked(page: Page, selector: string): Promise<void> {
  await expect.poll(() => panelFrame(page) !== undefined, { timeout: 15_000 }).toBe(true);
  const code = panelFrame(page)?.locator('code');
  if (code === undefined) throw new Error('no panel');
  await expect(code).toHaveText(selector, { timeout: 15_000 });
}

test('right-click on an image: the picker opens with the image picked', async ({ context, serviceWorker }) => {
  const page = await openHintPage(context);
  await rightClick(serviceWorker, { mediaType: 'image', srcUrl: `${ORIGIN}/pic.png` });
  await expectPicked(page, '#pic');
});

test('right-click inside an iframe: the picker opens with the frame picked', async ({ context, serviceWorker }) => {
  const page = await openHintPage(context);
  await rightClick(serviceWorker, { frameId: 1, frameUrl: `${ORIGIN}/frame.html` });
  await expectPicked(page, '#frm');
});

test('a hint that matches nothing: the overlay waits for a pick, as before', async ({ context, serviceWorker }) => {
  const page = await openHintPage(context);
  await rightClick(serviceWorker, { mediaType: 'image', srcUrl: `${ORIGIN}/elsewhere.png` });
  await expect.poll(() => overlayOpen(page), { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(500);
  expect(panelFrame(page)).toBeUndefined();
});
