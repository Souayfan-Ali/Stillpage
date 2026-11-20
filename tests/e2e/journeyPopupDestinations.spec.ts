/**
 * J18, known pop-up destinations (P2-61, testing notes §6, pop-up notes §6, §14) over the `popup-destinations/`
 * rows of fixtures.json, with the `popups` ruleset built from the rows' `$popup` filters. Runs now,
 * block-only: a listed host reached by `window.open`, a link, a 302 chain, a typed address, a same-tab
 * redirect, the P9 frame overlay and the P10 scripted form never receives a request; the `@@…$popup`
 * host opens; with site access "on click" the block still holds. No worker wake-up in any of it (boot
 * counter, S-22). The blocked page's presentation (P2-55; guard on, as the user turns it on) and the
 * "Allow pop-ups" opener (P2-60, set from the toolbar panel page) are separate runs.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { loadPopupFixtures, skippedWhole, type PopupRow } from '../fixtures/popupManifest.js';
import { expectationFailures, wakeGate, type Observed } from '../fixtures/popupGates.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { nonLoopbackPeers } from '../fixtures/server/sockets.js';
import { closeAll, expectNoSurvivors } from './helpers/browser.js';
import { enableGuard } from './helpers/guardMode.js';
import { createCorpusExtension, reconciledSince, setSiteAccess, type CorpusExtension } from './helpers/corpus.js';
import { runRow } from './helpers/popupRun.js';
import { startSession } from './helpers/session.js';

const ROWS = loadPopupFixtures().filter((r) => r.family === 'popup-destinations');
const RUNNABLE = ROWS.filter((r) => !skippedWhole(r));
const RUN_TIMEOUT_MS = 120_000;

let server: FixtureServer;
let extension: CorpusExtension;
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
  extension = await createCorpusExtension([], ROWS);
});

test.afterEach(async () => {
  await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
  contexts.clear();
  await closeAll();
});

test.afterAll(async () => {
  await server.close();
  await extension.remove();
  await expectNoSurvivors();
});

async function runAll(rows: readonly PopupRow[], access?: 'none'): Promise<void> {
  const s = await startSession(server, extension.dir, contexts);
  if (access !== undefined) {
    const since = Date.now();
    await setSiteAccess(s.context, s.id, access, rows[0]?.page ?? '');
    await reconciledSince(s.worker, since, /^permissions$/);
  }
  const boots = await s.probe.boots();
  const observed: Observed[] = [];
  for (const row of rows) observed.push({ row, verdict: (await runRow(server, s.context, row)).verdict });
  expect(expectationFailures(observed, 'guardOff')).toEqual([]);
  expect(wakeGate(boots, await s.probe.boots())).toEqual({ pass: true, wakes: 0 });
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
}

test('J18 block-only: listed hosts never reached by any route; the exception host opens; wake-ups 0', async () => {
  test.setTimeout(RUN_TIMEOUT_MS);
  const rows = RUNNABLE.filter((r) => r.setup === undefined && r.blockedPage === undefined);
  expect(rows.map((r) => r.technique)).toEqual(expect.arrayContaining(['D1', 'D2', 'D3', 'D4', 'D5', 'D7', 'P9', 'P10']));
  await runAll(rows);
});

test('J18 site access "on click": the listed host is still blocked, not redirected; wake-ups 0', async () => {
  test.setTimeout(RUN_TIMEOUT_MS);
  const rows = RUNNABLE.filter((r) => r.setup?.access === 'none');
  expect(rows).toHaveLength(1);
  await runAll(rows, 'none');
});

/** pop-up notes §6.2: the button the blocked page offers first. */
const PRIMARY: Readonly<Record<string, string>> = { 'close-tab': 'Close tab', 'go-back': 'Go back' };

/** What a presentation row must show: `closed` closes the tab (the opener's sentinel logs it), `proceed-once` lets it through. */
function presentation(row: PopupRow, run: Awaited<ReturnType<typeof runRow>>): object {
  if (row.blockedPage === 'closed') return { id: row.id, verdict: run.verdict, selfClosed: run.selfClosed };
  if (row.blockedPage === 'proceed-once') return { id: row.id, verdict: run.verdict, shown: run.blockedPrimary !== null };
  return { id: row.id, verdict: run.verdict, primary: run.blockedPrimary };
}

function wanted(row: PopupRow): object {
  if (row.blockedPage === 'closed') return { id: row.id, verdict: 'blocked', selfClosed: true };
  if (row.blockedPage === 'proceed-once') return { id: row.id, verdict: 'opened', shown: true };
  return { id: row.id, verdict: 'blocked', primary: PRIMARY[row.blockedPage ?? ''] };
}

test('J18 blocked page: Close tab for a fresh typed tab, Go back after a same-tab redirect, a fresh pop-up closes itself, Proceed once lets one through', async () => {
  test.setTimeout(RUN_TIMEOUT_MS);
  const rows = RUNNABLE.filter((r) => r.blockedPage !== undefined);
  expect(rows.map((r) => r.technique)).toEqual(expect.arrayContaining(['D10', 'D11']));
  const s = await startSession(server, extension.dir, contexts);
  // The redirect rules exist only with all-sites access; wait until the reconciler installed them (P2-55).
  await expect.poll(() => s.worker.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.action.type === 'redirect').length)).toBeGreaterThan(0);
  // The guard on (Smart), as the user turns it on: the opener's sentinel confirms a script open, so the fresh
  // pop-up closes itself; with the guard off it stays with "Close tab" first (P2-58, design review; hostile/blockedPage).
  await enableGuard(s, 'smart');
  const boots = await s.probe.boots();
  for (const row of rows.filter((r) => r.blockedPage !== 'proceed-once')) {
    const run = await runRow(server, s.context, row);
    expect(presentation(row, run)).toEqual(wanted(row));
  }
  // Nothing so far may wake the worker; "Proceed once" is the one step that does (pop-up notes §6.2).
  expect(wakeGate(boots, await s.probe.boots())).toEqual({ pass: true, wakes: 0 });
  for (const row of rows.filter((r) => r.blockedPage === 'proceed-once')) expect(presentation(row, await runRow(server, s.context, row))).toEqual(wanted(row));
});

test('J18 an "Allow pop-ups" site: a listed destination it opens is not acted on (opener allow rule); wake-ups 0', async () => {
  test.setTimeout(RUN_TIMEOUT_MS);
  const rows = RUNNABLE.filter((r) => r.setup?.sitePolicy === 'allow');
  expect(rows.map((r) => r.technique)).toEqual(['D13']);
  const s = await startSession(server, extension.dir, contexts);
  const host = new URL(rows[0]?.page ?? '').hostname;
  // As the user does it: the toolbar panel's "Allowed" for the opener site (P2-60b), then the opener rule is in.
  const panel = await s.context.newPage();
  await panel.goto(`chrome-extension://${s.id}/popup.html?tabId=1`);
  const answer: unknown = await panel.evaluate((hostname) => chrome.runtime.sendMessage({ v: 1, type: 'c/setSitePopupPolicy', id: 'j18', payload: { hostname, policy: 'allow' } }), host);
  expect(answer).toMatchObject({ ok: true });
  await expect.poll(() => panel.evaluate(async (h) => (await chrome.declarativeNetRequest.getDynamicRules()).some((r) => r.action.type === 'allow' && (r.condition.initiatorDomains ?? []).includes(h)), host)).toBe(true);
  await panel.close();
  const boots = await s.probe.boots();
  const observed: Observed[] = [];
  for (const row of rows) observed.push({ row, verdict: (await runRow(server, s.context, row)).verdict });
  expect(expectationFailures(observed, 'guardOff')).toEqual([]);
  expect(wakeGate(boots, await s.probe.boots())).toEqual({ pass: true, wakes: 0 });
});

for (const row of ROWS.filter(skippedWhole)) {
  test(`J18 ${row.id} (pending)`, () => {
    test.skip(true, row.pending);
  });
}
