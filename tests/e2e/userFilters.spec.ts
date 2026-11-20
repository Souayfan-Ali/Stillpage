/**
 * J8 and P2-20 in the real build: "Hide something" in the toolbar panel starts the picker; "Hide always"
 * saves through the worker (vault, `uf:*` mirror, `user-cosmetic` registration) and the element stays
 * hidden after a reload at `document_start`; Undo in the toast removes it again; the keyboard shortcut;
 * a tampered mirror applies nothing but `display:none` and the next reconcile repairs it. Chrome's own
 * context menu and accelerators cannot be driven from Playwright, so D-61 (P2-21) fires the worker's real
 * listeners with `onClicked.dispatch` / `onCommand.dispatch` (present in the bundled Chromium) through to
 * the overlay on the page; the manual check of the real menu and shortcut is in `docs/release-checklist.md`.
 */
import { expect, type Worker } from '@playwright/test';
import { test } from './fixtures.js';
import { armed } from './helpers/pickerPanel.js';
import { display, HIDE_ORIGIN, hideSomething, mirror, openHidePage as openPage, overlayOpen, pickAndHideAlways, RECONCILE, userScript } from './helpers/hider.js';

test('J8: Hide something → Hide always → hidden after reload (user-cosmetic at document_start); Undo restores', async ({ context, serviceWorker }) => {
  test.setTimeout(180_000);
  const page = await openPage(context);
  await hideSomething(context, serviceWorker);
  await pickAndHideAlways(page, '#ad');
  expect(await mirror(serviceWorker)).toEqual({ 'uf:hide.example': { v: 1, s: ['#ad'] } });
  await expect.poll(() => userScript(serviceWorker), RECONCILE).toBe(true);
  await page.reload();
  await expect.poll(() => display(page, '#ad')).toBe('none');
  expect(await display(page, '#keep')).not.toBe('none');

  await page.bringToFront();
  await hideSomething(context, serviceWorker);
  const panel = await pickAndHideAlways(page, '#keep');
  expect(await display(page, '#keep')).toBe('none');
  await (await armed(panel.getByRole('button', { name: 'Undo' }))).click();
  await expect.poll(() => display(page, '#keep')).not.toBe('none');
  expect(await mirror(serviceWorker)).toEqual({ 'uf:hide.example': { v: 1, s: ['#ad'] } });
});

test('J8: the keyboard shortcut starts the picker', async ({ context }) => {
  const page = await openPage(context);
  await page.keyboard.press('Alt+Shift+H');
  const started = await expect.poll(() => overlayOpen(page), { timeout: 3_000 }).toBe(true).then(() => true, () => false);
  test.info().annotations.push({ type: 'shortcut', description: started ? 'Alt+Shift+H started the picker' : 'Playwright key events do not reach Chrome accelerators; handler unit-tested' });
  if (!started) test.skip(true, 'Chrome accelerators are not reachable from Playwright key events');
});

/** The fixture tab as the worker sees it (id and URL), for an event dispatched with that tab. */
const hideTab = (sw: Worker): Promise<{ id: number; url: string }> =>
  sw.evaluate(async (origin) => {
    const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
    return { id: tab?.id ?? -1, url: tab?.url ?? '' };
  }, HIDE_ORIGIN);

test('J8 (D-61): the context menu entry "Hide element" starts the picker on the page', async ({ context, serviceWorker }) => {
  const page = await openPage(context);
  const tab = await hideTab(serviceWorker);
  await serviceWorker.evaluate((t) => {
    const info = { menuItemId: 'hide-element', editable: false, pageUrl: t.url, frameId: 0 } as chrome.contextMenus.OnClickData;
    (chrome.contextMenus.onClicked as unknown as { dispatch: (i: unknown, tb: unknown) => void }).dispatch(info, { id: t.id, url: t.url });
  }, tab);
  await expect.poll(() => overlayOpen(page), { timeout: 15_000 }).toBe(true);
});

test('J8 (D-61): the "hide-element" command is declared with its shortcut and starts the picker on the page', async ({ context, serviceWorker }) => {
  const page = await openPage(context);
  const commands = await serviceWorker.evaluate(() => chrome.commands.getAll());
  expect(commands.find((c) => c.name === 'hide-element')).toMatchObject({ shortcut: expect.stringMatching(/H$/) });
  const tab = await hideTab(serviceWorker);
  await serviceWorker.evaluate((t) => {
    (chrome.commands.onCommand as unknown as { dispatch: (n: string, tb: unknown) => void }).dispatch('hide-element', { id: t.id, url: t.url });
  }, tab);
  await expect.poll(() => overlayOpen(page), { timeout: 15_000 }).toBe(true);
});

test('tampered mirror: only display:none is ever applied, and the next reconcile restores it from the vault', async ({ context, serviceWorker }) => {
  test.setTimeout(180_000);
  const page = await openPage(context);
  await hideSomething(context, serviceWorker);
  await pickAndHideAlways(page, '#ad');
  await expect.poll(() => userScript(serviceWorker), RECONCILE).toBe(true);
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ 'uf:hide.example': { v: 1, s: ['body{background:red}', 'p{color:red} #keep', '#keep'] }, 'uf:evil.example': { v: 1, s: ['html'] } });
  });
  await page.reload();
  await expect.poll(() => display(page, '#keep')).toBe('none');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  // Any reconcile re-derives the mirror; a command from an extension page asks for one.
  const ext = await context.newPage();
  await ext.goto(serviceWorker.url().replace('background.js', 'popup.html?tabId=1'));
  await ext.evaluate(() => chrome.runtime.sendMessage({ v: 1, type: 'c/reconcile', id: 'tamper', payload: {} }));
  await expect.poll(() => mirror(serviceWorker), RECONCILE).toEqual({ 'uf:hide.example': { v: 1, s: ['#ad'] } });
});
