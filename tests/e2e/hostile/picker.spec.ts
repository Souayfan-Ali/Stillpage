/**
 * J15 · the element picker (P2-18…P2-21): overlay and panel under a page that covers them with top-layer
 * elements, decoys and forged messages. The picker is started the user's way: the toolbar panel's
 * "Hide something" (as a popup window: Playwright cannot click the toolbar button). Clicks are real
 * (trusted) mouse and key events; a covered click must save nothing (the panel's visibility gate, design review).
 */
import { test, expect, type Frame, type Page } from '@playwright/test';
import { english } from '../../helpers/chromeI18n.js';
import { armed } from '../helpers/pickerPanel.js';
import { call, expectNoExtensionNetwork, globalNames, HOST, openHostile, POLL, SESSION_TIMEOUT_MS, startHostile, stopHostile, type Hostile } from './harness.js';

/** Longer than the overlay's guard interval (250 ms) with a margin for a loaded machine. */
const GUARD_SETTLE_MS = 1_000;
/** How long a refused click is given to have reached the worker anyway. */
const SAVE_SETTLE_MS = 2_000;
const KEY = `uf:${HOST}`;

let h: Hostile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(SESSION_TIMEOUT_MS);
  h = await startHostile();
});
test.afterAll(async () => { await stopHostile(); });

const mirror = (): Promise<unknown> => h.worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, KEY);

async function startPicker(tab: Page): Promise<void> {
  await tab.bringToFront();
  const tabId = await h.worker.evaluate(async (url) => (await chrome.tabs.query({ url })).at(-1)?.id ?? -1, tab.url());
  const opened = h.context.waitForEvent('page');
  await h.worker.evaluate(async (id) => { await chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?tabId=${String(id)}`), type: 'popup' }); }, tabId);
  const popup = await opened;
  await popup.getByRole('button', { name: 'Hide something' }).click();
  await expect.poll(() => call(tab, '__overlayOpen'), POLL).toBe(true);
}

async function panelOf(tab: Page): Promise<Frame> {
  await expect.poll(() => tab.frames().some((f) => f.url().includes('picker-panel.html')), POLL).toBe(true);
  const frame = tab.frames().find((f) => f.url().includes('picker-panel.html'));
  if (frame === undefined) throw new Error('no panel');
  await frame.locator('[role="dialog"]').waitFor();
  return frame;
}

/** Opens the page, starts the picker, picks `selector` with a real click; the panel is shown and visible. */
async function pick(selector: string, before?: (tab: Page) => Promise<unknown>): Promise<{ tab: Page; panel: Frame }> {
  const tab = await openHostile(h, 'picker');
  await before?.(tab);
  await startPicker(tab);
  const box = await tab.locator(selector).boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  await tab.mouse.move(box.x + 10, box.y + 10);
  await tab.mouse.click(box.x + 10, box.y + 10);
  const panel = await panelOf(tab);
  await expect(panel.locator('code')).toHaveText(selector);
  await armed(panel.locator('button[data-hide]'));
  return { tab, panel };
}

/** A real click at the centre of `button` in the panel, whatever the page drew over it. */
async function clickThrough(tab: Page, panel: Frame, button: string): Promise<void> {
  const b = await panel.locator(button).boundingBox();
  if (b === null) throw new Error(`no box for ${button}`);
  await tab.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

/** A page popover that hit-testing skips, drawn over the panel and kept there by suppressing toggle events. */
async function stickyDecoy(tab: Page): Promise<void> {
  await call(tab, '__suppressToggles');
  await call(tab, '__cover', true);
  await tab.waitForTimeout(GUARD_SETTLE_MS);
  await call(tab, '__reshow');
  await tab.waitForTimeout(GUARD_SETTLE_MS);
}

test('positive control: an uncovered pick saves; the overlay leaves no global and the page never sees our shadow root', async () => {
  let globals: readonly string[] = [];
  const { tab, panel } = await pick('#ad', async (t) => { globals = await globalNames(t); });
  await panel.locator('button[data-hide]').click();
  await expect(panel.locator('.toast')).toContainText('Hidden.', POLL);
  expect(await mirror()).toEqual({ v: 1, s: ['#ad'] });
  expect(await tab.evaluate(() => (window as unknown as { __shadowHooks: number }).__shadowHooks)).toBe(0);
  expect(await call(tab, '__overlayOpen')).toBe(true);
  expect(await tab.evaluate(() => document.documentElement.lastElementChild?.shadowRoot ?? null)).toBeNull();
  expect(await globalNames(tab)).toEqual(globals);
  await tab.close();
});

test('a page popover re-shown above the picker: the picker is put back on top', async () => {
  const tab = await openHostile(h, 'picker');
  await startPicker(tab);
  await call(tab, '__cover', false);
  await expect.poll(() => call(tab, '__topAt', 300, 300), POLL).toBe('picker');
  await call(tab, '__reshow');
  await tab.waitForTimeout(GUARD_SETTLE_MS);
  expect(await call(tab, '__topAt', 300, 300)).toBe('picker');
  await tab.close();
});

test('a page that keeps re-showing its popover ends the picker (MAX_PROMOTIONS)', async () => {
  const tab = await openHostile(h, 'picker');
  await startPicker(tab);
  await call(tab, '__cover', false);
  await call(tab, '__reshowLoop');
  await expect.poll(() => call(tab, '__overlayOpen'), POLL).toBe(false);
  await tab.close();
});

test('a pass-through decoy kept above the panel: a real click on Hide always saves nothing and the panel says why', async () => {
  const before = await mirror();
  const { tab, panel } = await pick('#keep');
  await stickyDecoy(tab);
  await clickThrough(tab, panel, 'button[data-hide]');
  await tab.waitForTimeout(SAVE_SETTLE_MS);
  expect(await mirror()).toEqual(before);
  await expect(panel.locator('[data-covered]')).toHaveText(english('picker_covered'));
  // Still the panel's state, not the toast: the click was refused before anything was sent.
  await expect(panel.locator('.toast')).toHaveCount(0);
  await tab.close();
});

test('the same decoy and the keyboard: Enter on the focused Hide button saves nothing', async () => {
  const before = await mirror();
  const { tab, panel } = await pick('#keep');
  await panel.locator('button[data-hide]').focus();
  await stickyDecoy(tab);
  await tab.keyboard.press('Enter');
  await tab.keyboard.press('Space');
  await tab.waitForTimeout(SAVE_SETTLE_MS);
  expect(await mirror()).toEqual(before);
  await tab.close();
});

test('a decoy taken away 50 ms before the click: the click still saves nothing', async () => {
  const before = await mirror();
  const { tab, panel } = await pick('#keep');
  await stickyDecoy(tab);
  await call(tab, '__uncover');
  await tab.waitForTimeout(50);
  await clickThrough(tab, panel, 'button[data-hide]');
  await tab.waitForTimeout(SAVE_SETTLE_MS);
  expect(await mirror()).toEqual(before);
  await tab.close();
});

test('a legitimate page popover open before the picker: picking and the panel still work', async () => {
  const { tab, panel } = await pick('#keep', (t) => call(t, '__banner'));
  await panel.locator('button[data-cancel]').click({ timeout: POLL.timeout }).catch(() => undefined);
  await expect.poll(() => call(tab, '__overlayOpen'), POLL).toBe(false);
  await tab.close();
});

test('forged hellos, candidates and saves posted to every frame change nothing', async () => {
  const before = await mirror();
  const { tab, panel } = await pick('#keep');
  const code = await panel.locator('code').textContent();
  await tab.evaluate(() => {
    for (const target of Array.from({ length: window.frames.length }, (_, i) => window.frames[i])) {
      const ch = new MessageChannel();
      target?.postMessage({ type: 'hello', nonce: 'guessedNonce_00000000' }, '*', [ch.port2]);
      ch.port1.postMessage({ type: 'candidates', candidates: [{ selector: 'body', count: 1 }], initial: 0 });
      target?.postMessage({ type: 'saved', index: 0 }, '*');
      target?.postMessage({ v: 1, type: 'c/saveUserFilter', id: 'x', payload: { hostname: 'hostile.example', selector: 'body', nonce: 'guessedNonce_00000000' } }, '*');
    }
  });
  await tab.waitForTimeout(SAVE_SETTLE_MS);
  await expect(panel.locator('code')).toHaveText(code ?? '');
  expect(await mirror()).toEqual(before);
  // `body` (the forged candidate) is not hidden: only indices into our own candidates ever act.
  expect(await tab.evaluate(() => getComputedStyle(document.body).display)).not.toBe('none');
  await tab.close();
});

test('J16 row: no extension-initiated request during the picker probes', () => {
  expectNoExtensionNetwork(h);
});
