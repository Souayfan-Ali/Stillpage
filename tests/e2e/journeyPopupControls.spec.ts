/**
 * J19, pop-up controls (P2-61, testing notes §6): the hostile-notice step (P2-59, fixture `popups/h1-hostile-notice`).
 * The guard is on in Smart as the user turns it on. The fixture's script pokes every 100 ms: clicks every
 * button it can reach, posts and dispatches "notice" messages for a host the guard never blocked, and looks for
 * shadow roots. It can neither raise a notice nor make the one a real block drew act: the notice names only the
 * blocked host, and after script-made events at it the page's window stays blocked.
 *
 * J19's panel row, the page's count and list, the dashboard notice toggle and their keyboard-only runs are
 * `journeyPopupRow.spec.ts` (P2-60b); the dashboard mode and the restart are `dashboardPopups.spec.ts` (P2-60a);
 * the notice's keyboard, screen-reader, toggle and visual checks are `popupNotice.spec.ts`; the `notify/` rows
 * run in `notifyGate.spec.ts` (P2-63).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { loadPopupFixtures } from '../fixtures/popupManifest.js';
import { test } from './fixtures.js';
import { buttonCentre } from './hostile/closedShadow.js';
import { ARMED_MS, axLines, noticeBox, openNoticePage, opens, smartGuard } from './helpers/noticePage.js';

const ROWS = loadPopupFixtures();
const hostile = ROWS.find((r) => r.technique === 'H1');
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
/** Long enough for many 100 ms pokes. */
const POKES_MS = 2_000;

test(`J19 the notice cannot be raised or clicked by page script (${hostile?.id ?? 'missing'})`, async ({ context, serviceWorker, extensionId }) => {
  test.skip(hostile?.pending !== undefined, hostile?.pending);
  test.setTimeout(120_000);
  if (hostile?.target === undefined) throw new Error('no H1 row');
  const notice = hostile.notice ?? '';
  const click = 'click' in hostile.act ? hostile.act.click : '#text';
  await smartGuard(context, serviceWorker, extensionId);
  await context.route('https://never-blocked.example/**', (route) => route.fulfill({ body: '<title>x</title>', contentType: 'text/html' }));
  await context.route(`${new URL(hostile.target).origin}/**`, (route) => route.fulfill({ body: '<title>ad</title>', contentType: 'text/html' }));
  const page = await openNoticePage(context, await readFile(path.join(FIXTURES, hostile.file), 'utf8'));

  // Raise: the pokes alone draw nothing.
  await page.waitForTimeout(POKES_MS);
  expect(await noticeBox(page)).toBeNull();
  expect(await buttonCentre(page, 'Allow on this page')).toBeNull();

  // A real click on plain text: the page's window is blocked and the notice names that host only.
  expect(await opens(page, click)).toBe(false);
  await expect.poll(async () => (await axLines(page)).includes(`StaticText: Pop-up blocked · ${notice}`)).toBe(true);
  expect((await axLines(page)).some((l) => l.includes('never-blocked'))).toBe(false);

  // Click: after the arm delay, script-made events at the notice and the pokes open nothing and allow nothing.
  await page.waitForTimeout(ARMED_MS);
  const windows = context.pages().length;
  await page.evaluate(() => {
    const host = document.documentElement.lastElementChild;
    if (!(host instanceof HTMLElement)) return;
    const r = host.getBoundingClientRect();
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) host.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, clientX: r.right - 20, clientY: r.bottom - 10 }));
    host.click();
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await page.waitForTimeout(POKES_MS);
  expect(context.pages().length).toBe(windows);
  expect(await opens(page, click)).toBe(false);
  const pokes = await page.evaluate(() => (window as unknown as { __pokes?: number }).__pokes ?? 0);
  expect(pokes, 'the pokes ran and found no shadow root').toBe(1);
});
