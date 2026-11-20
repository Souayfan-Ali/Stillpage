/**
 * The `notify/` rows (P2-63, cosmetic notes §6a, pop-up notes P15) on the real build: `notify-gate.js` is registered only
 * while the Notification prompts pack is on; a prompt on load without a gesture is answered `"default"` without
 * Chrome's prompt; a prompt after a real click is untouched. Chromium runs with `--deny-permission-prompts`, so a
 * prompt Chrome would show answers `"denied"` (prompted) and a gated one answers `"default"` (suppressed).
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { loadPopupFixtures, type PopupRow } from '../fixtures/popupManifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { closeAll, expectNoSurvivors, extensionWorker, newProfile } from './helpers/browser.js';
import { launchCorpus, reconciledSince } from './helpers/corpus.js';
import { BUILD_DIR } from './helpers/fixtureExtension.js';

const ROWS = loadPopupFixtures().filter((r) => r.family === 'notify');
const POLL = { timeout: 10_000, intervals: [50, 100, 250] };

let server: FixtureServer;
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
});

test.afterEach(async () => {
  await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
  contexts.clear();
  await closeAll();
});

test.afterAll(async () => {
  try {
    await (server as FixtureServer | undefined)?.close();
  } finally {
    await expectNoSurvivors();
  }
});

/** The real build with the pack on or off (`c/setPack` from the toolbar panel page, as the user would). */
async function session(packOn: boolean): Promise<{ readonly context: BrowserContext; readonly panel: Page }> {
  const since = Date.now();
  const context = await launchCorpus(await newProfile(), BUILD_DIR, [...server.chromiumArgs, '--deny-permission-prompts']);
  contexts.add(context);
  const worker = await extensionWorker(context);
  await reconciledSince(worker, since, /^installed:/);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  if (packOn) {
    const answer: unknown = await panel.evaluate(() => chrome.runtime.sendMessage<object, unknown>({ v: 1, type: 'c/setPack', id: 'n1', payload: { pack: 'annoy-notifications', enabled: true } }));
    expect(answer).toMatchObject({ ok: true });
  }
  const registered = (): Promise<number> => panel.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['notify-gate'] })).length);
  await expect.poll(registered, POLL).toBe(packOn ? 1 : 0);
  return { context, panel };
}

/** Loads the row's page, acts, and reads what `Notification.requestPermission()` answered. */
async function observe(context: BrowserContext, row: PopupRow): Promise<'prompted' | 'suppressed'> {
  const page = await context.newPage();
  await page.goto(row.page, { waitUntil: 'load' });
  // The `notify/` rows act by nothing (on load) or by one real click on the page.
  if ('click' in row.act && !('frame' in row.act)) await page.click(row.act.click);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __answer?: string }).__answer ?? null), POLL).not.toBeNull();
  const answer = await page.evaluate(() => (window as unknown as { __answer?: string }).__answer);
  await page.close();
  return answer === 'default' ? 'suppressed' : 'prompted';
}

for (const row of ROWS) {
  for (const packOn of [false, true]) {
    const expected = packOn ? row.expect.packOn : row.expect.packOff;
    test(`${row.id}: pack ${packOn ? 'on' : 'off'} → ${expected ?? '?'}`, async () => {
      test.setTimeout(90_000);
      test.skip(row.pending !== undefined, row.pending);
      const { context } = await session(packOn);
      expect(await observe(context, row)).toBe(expected);
    });
  }
}
