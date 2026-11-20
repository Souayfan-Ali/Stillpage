/**
 * Journey J16 (P1-46, testing notes §6, security notes §9): with CDP network logging on the worker, the
 * extension's pages and every web page, a session of ordinary use makes zero extension-initiated
 * requests: a command run, browsing the whole fixture corpus, the toolbar panel, and an in-place update
 * (the install-time reconcile again, under the logger). Positive controls show that a request from
 * the worker and from an extension page would be caught, so zero is not vacuous. The attached
 * debugger keeps the worker alive, so wake-ups are not counted here (J2, J3). The breakage report's
 * "Open a new issue" is clicked too (D-101 D): the resolver rules map `github.com` to the fixture
 * server, whose stand-in page answers it (never the live web), and the tab it opens is the browser's
 * own navigation, not a request by the extension.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { ISSUE_TRACKER_URL } from '../../src/core/tracker.js';
import { loadFixtures } from '../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { nonLoopbackPeers } from '../fixtures/server/sockets.js';
import { lastRunSince, openProbe } from './helpers/bootCounter.js';
import { closeAll, expectNoSurvivors, updateInPlace } from './helpers/browser.js';
import { extensionInitiated, startNetworkLog, type NetworkLog } from './helpers/cdpNetwork.js';
import { createCorpusExtension, type CorpusExtension } from './helpers/corpus.js';
import { expectFixture } from './helpers/observe.js';
import { openPanel, startSession, tabIdOf } from './helpers/session.js';

const ALL = loadFixtures();
const BROWSE_FAMILIES = new Set(['net', 'redirect', 'cosmetic-specific', 'cosmetic-procedural', 'scriptlets', 'anti-adblock']);
const BROWSE = ALL.filter((f) => BROWSE_FAMILIES.has(f.family) && f.pending === undefined);
const PANEL_PAGE = 'https://levels.example/levels/page.html';
const CONTROL = 'https://j16-control.example/control.js';
const JOURNEY_TIMEOUT_MS = 180_000;
const POLL = { timeout: 10_000, intervals: [50, 100, 250] };
const NEW_ISSUE = `${ISSUE_TRACKER_URL}/issues/new`;

let server: FixtureServer;
let extension: CorpusExtension;
let log: NetworkLog | undefined;
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
  extension = await createCorpusExtension(ALL);
});

test.afterEach(async () => {
  await log?.close();
  log = undefined;
  await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
  contexts.clear();
  await closeAll();
});

test.afterAll(async () => {
  try {
    await (server as FixtureServer | undefined)?.close();
    await (extension as CorpusExtension | undefined)?.remove();
  } finally {
    await expectNoSurvivors();
  }
});

/** Walks the breakage flow to the report on `panel` and clicks "Open a new issue"; returns the new tab. */
async function openNewIssue(context: BrowserContext, panel: Page): Promise<Page> {
  await panel.getByRole('button', { name: 'Something wrong with this page?' }).click();
  await panel.getByRole('button', { name: 'The page looks broken or will not work' }).click();
  await panel.getByRole('button', { name: 'Try it and reload' }).click();
  await expect(panel.getByText('After the reload:')).toBeVisible();
  await panel.getByRole('button', { name: 'Still broken' }).click();
  await panel.getByRole('button', { name: 'Report this (you review everything first)' }).click();
  const opened = context.waitForEvent('page');
  await panel.getByRole('button', { name: 'Open a new issue' }).click();
  const tab = await opened;
  await tab.waitForLoadState('load');
  // The fixture server's stand-in page for any host (`tests/fixtures/server/server.ts`): never the live web.
  await expect(tab).toHaveTitle('github.com');
  return tab;
}

async function bumpVersion(dir: string): Promise<void> {
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...manifest, version: '0.0.2' }));
}

test('J16 no network: zero extension-initiated requests from the worker, its pages and web pages', async () => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const s = await startSession(server, extension.dir, contexts);
  const network = await startNetworkLog(s.profile);
  log = network;
  const fromWorker = (): number => network.requests().filter((r) => r.targetType === 'service_worker').length;

  const since = Date.now();
  await s.probe.page.evaluate(() => chrome.runtime.sendMessage({ v: 1, type: 'c/reconcile', id: 'j16', payload: {} }));
  await lastRunSince(s.probe, since, /^command$/);
  for (const fixture of BROWSE) await expectFixture(server, s.context, fixture);
  const page = await s.context.newPage();
  await page.goto(PANEL_PAGE);
  const panel = await openPanel(s, await tabIdOf(s.probe.page, PANEL_PAGE));
  await expect(panel.locator('[data-state="normal"]')).toBeVisible();
  const issue = await openNewIssue(s.context, panel);
  expect(`${new URL(issue.url()).origin}${new URL(issue.url()).pathname}`).toBe(NEW_ISSUE);

  await bumpVersion(extension.dir);
  const { startedAt } = await updateInPlace(s.context, s.profile, extension.dir);
  const probe = await openProbe(s.context, s.id);
  await lastRunSince(probe, startedAt, /^installed:update$/);

  const all = network.requests();
  test.info().annotations.push({ type: 'logged requests', description: `${String(all.length)} (worker ${String(fromWorker())})` });
  expect(all.length, 'the logger saw the browsing').toBeGreaterThan(BROWSE.length);
  // The new-issue tab reached the local stand-in as a top-level document load (a request by the
  // extension would be a fetch, destination "empty"). The CDP log does not see a tab's first navigation
  // when `tabs.create` starts it before the target attaches, so it attributes that load to nobody.
  // Chrome may also ask the stand-in for the tab's favicon; nothing else may reach it.
  const atStub = server.log().filter((r) => r.host === 'github.com' && r.path !== '/favicon.ico');
  test.info().annotations.push({ type: 'new issue load', description: JSON.stringify({ server: server.log().filter((r) => r.host === 'github.com').map((r) => `${r.dest ?? '?'} ${r.path.slice(0, 40)}`), cdp: all.filter((r) => r.url.startsWith(NEW_ISSUE)) }) });
  expect(atStub.map((r) => ({ dest: r.dest, issuePage: `https://github.com${r.path}`.startsWith(`${NEW_ISSUE}?`) }))).toEqual([{ dest: 'document', issuePage: true }]);
  expect(extensionInitiated(all, s.id)).toEqual([]);
  expect(nonLoopbackPeers(s.profile)).toEqual([]);

  // Positive controls, after the measurement: a fetch from an extension page and from the worker.
  await probe.page.evaluate((url) => fetch(url).then(() => undefined), CONTROL);
  const worker = s.context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${s.id}/`));
  await worker?.evaluate((url) => fetch(url).then(() => undefined), CONTROL);
  await expect
    .poll(() => extensionInitiated(network.requests(), s.id).map((r) => `${r.targetType} ${r.url}`), POLL)
    .toEqual(expect.arrayContaining([`page ${CONTROL}`, `service_worker ${CONTROL}`]));
});
