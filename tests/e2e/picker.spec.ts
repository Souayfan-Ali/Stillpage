/**
 * P2-18 / P2-19 in real Chromium: the picker overlay (closed shadow root, keyboard, no page globals),
 * the panel handshake over the `use_dynamic_url` iframe, preview, and a hostile page that cannot save.
 * The worker's `c/startPicker` handler is P2-20/P2-21's: here the test does what it will do (session
 * record in `storage.session`, `executeScript`, `x/pickerStart`) from the service worker. A message
 * spy in the worker records what reaches it; it answers nothing, so the real handler still replies.
 */
import { expect, type Frame, type Locator, type Page, type Worker } from '@playwright/test';
import { test } from './fixtures.js';
import { armed } from './helpers/pickerPanel.js';

/** How long a click that removes its own frame may take before the outcome check decides (a bound, P2-47 stability). */
const CLOSING_CLICK_MS = 10_000;

/**
 * Cancel removes the panel's iframe while Playwright still waits for that frame to acknowledge the click; at
 * load ≥ 40 the acknowledgement never came and `click()` hung until the test timeout (2 of 6 full runs,
 * P2-47 stability). The click is dispatched all the same; the caller then checks its outcome (overlay gone).
 */
async function clickClosingPanel(button: Locator): Promise<void> {
  await button.click({ timeout: CLOSING_CLICK_MS }).catch((error: unknown) => {
    if (!String(error).includes('closed') && !String(error).includes('Timeout')) throw error;
  });
}

const ORIGIN = 'https://picker.example';
const NONCE = 'e2eNonce_0123456789abcd';
const PAGE = `<!doctype html><title>picker</title>
<style>body{margin:0;font:16px sans-serif} li{height:40px} #ad{width:300px;height:250px;background:#ccc}</style>
<ul class="results"><li class="row">one</li><li class="row" id="mid">two</li><li class="row">three</li></ul>
<div id="ad" class="ad-box">ad</div><button id="before">focus me</button>`;

interface Seen { readonly type: unknown; readonly url: string | undefined; readonly payload: unknown }

async function openFixture(context: import('@playwright/test').BrowserContext): Promise<Page> {
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ body: PAGE, contentType: 'text/html' }));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  return page;
}

/** What the worker will do on `c/startPicker` (P2-20/P2-21), plus a spy on what reaches it. */
async function startPicker(sw: Worker, nonce = NONCE): Promise<void> {
  await sw.evaluate(async ({ origin, nonce: n }) => {
    const g = self as unknown as { __seen?: unknown[] };
    if (g.__seen === undefined) {
      g.__seen = [];
      chrome.runtime.onMessage.addListener((m: { type?: unknown; payload?: unknown } | null, s) => {
        g.__seen?.push({ type: m?.type, url: s.url, payload: m?.payload });
      });
    }
    const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
    const tabId = tab?.id ?? -1;
    await chrome.storage.session.set({ [`picker:${n}`]: { tabId, hostname: 'picker.example', mode: 'hide', createdAt: Date.now(), claimed: false } });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['picker.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'x/pickerStart', nonce: n, mode: 'hide' }, { frameId: 0 });
  }, { origin: ORIGIN, nonce });
}

const seen = (sw: Worker): Promise<Seen[]> => sw.evaluate(() => (self as unknown as { __seen?: Seen[] }).__seen ?? []);

async function panelFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().includes('picker-panel.html'))).toBe(true);
  const frame = page.frames().find((f) => f.url().includes('picker-panel.html'));
  if (frame === undefined) throw new Error('no panel frame');
  await frame.locator('[role="dialog"]').waitFor();
  return frame;
}

const display = (page: Page, sel: string): Promise<string> => page.locator(sel).evaluate((el) => getComputedStyle(el).display);

test('overlay: closed shadow root, no page globals, keyboard pick, panel handshake, preview, save from the panel', async ({ context, serviceWorker }) => {
  test.setTimeout(60_000);
  const page = await openFixture(context);
  const globalsBefore = await page.evaluate(() => Object.getOwnPropertyNames(window).length);
  await startPicker(serviceWorker);
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length)).toBe(3);
  expect(await page.evaluate(() => {
    const host = document.documentElement.lastElementChild;
    return { shadow: host?.shadowRoot ?? null, id: host?.id, cls: host?.className, frames: document.querySelectorAll('iframe').length };
  })).toEqual({ shadow: null, id: '', cls: '', frames: 0 });
  expect(await page.evaluate(() => Object.getOwnPropertyNames(window).length)).toBe(globalsBefore);
  // Synthetic keys from the page do nothing; real keys move and pick.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })));
  await page.mouse.move(150, 60);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const panel = await panelFrame(page);
  await expect(panel.locator('code')).toHaveText('#mid');
  await expect(panel.locator('[data-count]')).toHaveText('Hides 1 item on this page');
  expect(await display(page, '#mid')).toBe('none');
  await panel.locator('input[type="checkbox"]').uncheck();
  await expect.poll(() => display(page, '#mid')).not.toBe('none');
  await panel.locator('input[type="checkbox"]').check();
  await (await armed(panel.locator('button[data-hide]'))).click();
  await expect.poll(async () => (await seen(serviceWorker)).filter((m) => m.type === 'c/saveUserFilter')).toEqual([{
    type: 'c/saveUserFilter', url: expect.stringContaining('picker-panel.html') as unknown,
    payload: { hostname: 'picker.example', selector: '#mid', nonce: NONCE },
  }]);
  // Since P2-20 the worker saves it: the panel turns into the "Hidden. Undo" toast; Undo removes it again.
  await expect(panel.locator('.toast')).toContainText('Hidden.', { timeout: 15_000 });
  await clickClosingPanel(await armed(panel.getByRole('button', { name: 'Undo' })));
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length), { timeout: 20_000 }).toBe(2);
});

test('hostile page: forged hellos and port messages reach nothing, nothing is saved, the overlay cannot be found', async ({ context, serviceWorker }) => {
  const page = await openFixture(context);
  await startPicker(serviceWorker);
  await page.mouse.move(150, 300);
  await page.keyboard.press('Enter');
  const panel = await panelFrame(page);
  const before = await panel.locator('code').textContent();
  const hostile = await page.evaluate(() => {
    const targets = Array.from({ length: window.frames.length }, (_, i) => window.frames[i]);
    for (const target of targets) {
      const ch = new MessageChannel();
      target?.postMessage({ type: 'hello', nonce: 'guessedNonce_00000000' }, '*', [ch.port2]);
      ch.port1.postMessage({ type: 'candidates', candidates: [{ selector: 'body', count: 1 }], initial: 0 });
      target?.postMessage({ type: 'saved', index: 0 }, '*');
    }
    return { frames: window.frames.length, iframes: document.querySelectorAll('iframe').length, hosts: document.querySelectorAll('html > div').length };
  });
  expect(hostile.iframes).toBe(0);
  await page.waitForTimeout(300);
  await expect(panel.locator('code')).toHaveText(before ?? '');
  expect((await seen(serviceWorker)).filter((m) => m.type === 'c/saveUserFilter')).toEqual([]);
  expect(await display(page, 'body')).not.toBe('none');
  await clickClosingPanel(panel.locator('button[data-cancel]'));
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length)).toBe(2);
});

test('a start message from the page or another nonce state does not start a second picker', async ({ context, serviceWorker }) => {
  const page = await openFixture(context);
  await startPicker(serviceWorker);
  await startPicker(serviceWorker, 'secondNonce_0123456789');
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length)).toBe(3);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length)).toBe(2);
});

test('a page modal <dialog> (top layer, everything else inert) ends the picker (security review MEDIUM-1)', async ({ context, serviceWorker }) => {
  const page = await openFixture(context);
  await startPicker(serviceWorker);
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length)).toBe(3);
  await page.evaluate(() => {
    const d = document.createElement('dialog');
    d.textContent = 'modal';
    document.body.append(d);
    d.showModal();
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length)).toBe(2);
});

test('the host is in the top layer; a page popover opened later does not stay above it', async ({ context, serviceWorker }) => {
  const page = await openFixture(context);
  await startPicker(serviceWorker);
  await expect.poll(() => page.evaluate(() => document.documentElement.lastElementChild?.matches(':popover-open') ?? false)).toBe(true);
  await page.evaluate(() => {
    const p = document.createElement('div');
    p.setAttribute('popover', 'manual');
    p.textContent = 'decoy';
    document.body.append(p);
    p.showPopover();
  });
  // Re-promoted: our host is the last-shown popover again, so the topmost element at the panel's corner is ours.
  await expect.poll(() => page.evaluate(() => document.elementFromPoint(5, 5) === document.documentElement.lastElementChild)).toBe(true);
  await page.keyboard.press('Escape');
});

test('a clobbering page (named elements shadowing document and form built-ins) still gets a working picker (MEDIUM-2)', async ({ context, serviceWorker }) => {
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>c</title>
    <img name="createElement"><img name="documentElement"><img name="elementsFromPoint"><img name="querySelectorAll"><img name="adoptedStyleSheets">
    <div id="wrap" style="padding:40px"><form class="signup" style="width:300px;height:200px;background:#eee"><input name="parentElement"><input name="id"><input name="classList"></form></div>` }));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  await startPicker(serviceWorker);
  await page.mouse.move(100, 100);
  await page.mouse.click(150, 150);
  const panel = await panelFrame(page);
  await expect(panel.locator('[data-count]')).toContainText('on this page');
  await clickClosingPanel(panel.locator('button[data-cancel]'));
  await expect.poll(() => page.evaluate(() => document.children[0]?.children.length)).toBe(2);
});
