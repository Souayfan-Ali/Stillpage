/**
 * Running one pop-up row of `fixtures.json` (P2-61, J17/J18): load the page, perform the row's trusted
 * user action, and decide `opened` or `blocked` by whether the target address was reached — the fixture
 * server saw a request for it (host and path prefix), or for `blob:` a tab with a blob URL appeared.
 * That is the invariant every mode shares (no request reaches a blocked host, pop-up notes §14); how the
 * block looks (blocked page, notice) is read by the rows that ask for it. `blocked` is only decided
 * after the full settle time, so a late window (S4: 1.5 s) is not missed.
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';
import type { PopupAct, PopupRow, PopupVerdict } from '../../fixtures/popupManifest.js';
import type { FixtureServer } from '../../fixtures/server/server.js';

const SETTLE_MS = 2_500;
const POLL_MS = 100;
const AFTER_LOAD_MS = 150;
const ALSO = { timeout: 2_000, intervals: [50, 100, 250] };

export interface RowRun {
  readonly verdict: PopupVerdict;
  /** The primary button of the blocked page that came up, or null when none did (rows with `blockedPage`). */
  readonly blockedPrimary: string | null;
  /** Every tab the action opened had closed itself by the time the verdict was taken. */
  readonly selfClosed: boolean;
  /** Page globals named by the row's `also`, read from the opener after the action. */
  readonly also: readonly unknown[];
}

export async function perform(page: Page, act: PopupAct): Promise<void> {
  if ('navigate' in act) {
    // An address typed into a fresh tab: made at its URL in a new window, so it has no history entry and no
    // `openerTabId` (a tab added to an existing window inherits the active tab as its opener, P2-47 stability).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Target.createTarget', { url: act.navigate, newWindow: true });
    await cdp.detach();
    return;
  }
  if ('clickAt' in act) return page.mouse.click(...act.clickAt);
  if ('press' in act) {
    await page.focus(act.focus);
    return page.keyboard.press(act.press);
  }
  if ('frame' in act) return page.frameLocator(act.frame).locator(act.click).click();
  if ('click' in act) return page.click(act.click, { ...(act.modifiers && { modifiers: [...act.modifiers] }), ...(act.button && { button: act.button }) });
}

function reachedNow(server: FixtureServer, target: string, opened: readonly Page[]): boolean {
  if (target === 'blob:') return opened.some((p) => p.url().startsWith('blob:'));
  const { hostname, pathname } = new URL(target);
  return server.log().some((r) => r.host === hostname && r.path.startsWith(pathname));
}

async function reached(server: FixtureServer, target: string, opened: readonly Page[]): Promise<boolean> {
  for (let waited = 0; waited < SETTLE_MS; waited += POLL_MS) {
    if (reachedNow(server, target, opened)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return reachedNow(server, target, opened);
}

const BLOCKED_WAIT = { timeout: 5_000, intervals: [100, 250] };

/** The first button of a blocked page shown in the opener or a tab it made (pop-up notes §6.2). */
async function blockedPrimary(pages: readonly Page[]): Promise<string | null> {
  const find = (): Page | undefined => pages.find((p) => !p.isClosed() && /^chrome-extension:\/\/[a-p]{32}\/blocked\.html/.test(p.url()));
  await expect.poll(() => find() !== undefined, BLOCKED_WAIT).toBe(true).catch(() => undefined);
  const page = find();
  return page === undefined ? null : ((await page.locator('.actions button').first().textContent()) ?? '').trim();
}

/** Clicks "Proceed once" on the blocked page that came up; `opened` if the listed host is then reached. */
async function proceedOnce(server: FixtureServer, target: string, pages: readonly Page[]): Promise<PopupVerdict> {
  const page = pages.find((p) => !p.isClosed() && /^chrome-extension:\/\/[a-p]{32}\/blocked\.html/.test(p.url()));
  if (page === undefined) return 'blocked';
  server.clearLog();
  await page.getByRole('button', { name: 'Proceed once' }).click();
  return (await reached(server, target, [page])) ? 'opened' : 'blocked';
}

async function readAlso(page: Page, row: PopupRow): Promise<unknown[]> {
  const wanted = (row.also ?? []).map((a) => a.is);
  const read = (): Promise<unknown[]> =>
    Promise.all((row.also ?? []).map((a) => page.evaluate((name) => (window as unknown as Record<string, unknown>)[name] ?? null, a.global).catch(() => 'page gone')));
  await expect.poll(read, ALSO).toEqual(wanted).catch(() => undefined);
  return read();
}

/** Loads `row.page` in a fresh tab, performs the action, and returns the verdict; closes every tab it made. */
export async function runRow(server: FixtureServer, context: BrowserContext, row: PopupRow): Promise<RowRun> {
  if (row.target === undefined) throw new Error(`${row.id}: no target`);
  server.clearLog();
  const page = await context.newPage();
  const opened: Page[] = [];
  const onPage = (p: Page): void => {
    opened.push(p);
  };
  try {
    await page.goto(row.page, { waitUntil: 'load' });
    await page.waitForTimeout(AFTER_LOAD_MS);
    context.on('page', onPage);
    await perform(page, row.act);
    const firstVerdict: PopupVerdict = (await reached(server, row.target, opened)) ? 'opened' : 'blocked';
    const primary = row.blockedPage === undefined ? null : await blockedPrimary([page, ...opened]);
    // Every tab the action opened closed by itself (the blocked page's "close" row, pop-up notes §6.2).
    const selfClosed = opened.length > 0 && opened.every((p) => p.isClosed());
    // "Proceed once" (P2-55): the user's click on the blocked page lets that tab through, once.
    const verdict = row.blockedPage === 'proceed-once' && primary !== null ? await proceedOnce(server, row.target, [page, ...opened]) : firstVerdict;
    return { verdict, blockedPrimary: primary, selfClosed, also: await readAlso(page, row) };
  } finally {
    context.off('page', onPage);
    await Promise.all([...opened, page].map((p) => p.close().catch(() => undefined)));
  }
}
