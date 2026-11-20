/**
 * J17, pop-up guard (P2-61, testing notes §6, pop-up notes §14) over the `popups/` and `popups-allow/` rows of
 * fixtures.json. What runs now: the guard-off baseline (every must-block page really opens its window
 * or tab-under, every must-pass page works — the fixtures bite) with the must-pass and wake-up gates,
 * and the stale-marker tripwire over every pop-up row. The Smart and Strict runs with the block-rate
 * gate are skipped with the rows' pending reason until the guard (P2-57/P2-58) exists; the tripwire
 * fails as soon as the guard ships while a row still says pending.
 */
import { readdir } from 'node:fs/promises';
import { test, expect, type BrowserContext } from '@playwright/test';
import { loadPopupFixtures, type PopupRow } from '../fixtures/popupManifest.js';
import { expectationFailures, mustPassGate, smartGate, staleMarkers, strictGate, wakeGate, type Mode, type Observed } from '../fixtures/popupGates.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { nonLoopbackPeers } from '../fixtures/server/sockets.js';
import { closeAll, expectNoSurvivors } from './helpers/browser.js';
import { createCorpusExtension, type CorpusExtension } from './helpers/corpus.js';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { enableGuard } from './helpers/guardMode.js';
import { runRow } from './helpers/popupRun.js';
import { startSession, type Session } from './helpers/session.js';

const ALL = loadPopupFixtures();
const GUARD_ROWS = ALL.filter((r) => r.family === 'popups' || r.family === 'popups-allow');
const RUN_TIMEOUT_MS = 300_000;
const GUARD_PENDING = GUARD_ROWS.find((r) => r.guardAlone === true && r.pending !== undefined)?.pending;

let server: FixtureServer;
let extension: CorpusExtension;
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
  extension = await createCorpusExtension([], GUARD_ROWS);
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

/** Every row in one session, with the also-observations checked; returns the verdicts. */
async function runAll(s: Session, rows: readonly PopupRow[], mode: Mode = 'guardOff'): Promise<Observed[]> {
  const observed: Observed[] = [];
  for (const row of rows) {
    const run = await runRow(server, s.context, row);
    // `also` observes the opened window's effect (e.g. a sign-in `postMessage`): it holds only where the row
    // expects the window to open in this mode (a Strict block leaves nothing to observe).
    const opens = (row.expect[mode] ?? 'opened') !== 'blocked';
    if (opens) expect({ id: row.id, also: run.also }).toEqual({ id: row.id, also: (row.also ?? []).map((a) => a.is) });
    observed.push({ row, verdict: run.verdict });
  }
  return observed;
}

test('J17 tripwire: no pop-up row is still pending for a feature the build ships', async () => {
  const files = (await readdir(BUILD_DIR, { recursive: true })).map(String);
  expect(files.length).toBeGreaterThan(0);
  expect(staleMarkers(ALL, files)).toEqual([]);
});

test('J17 guard off: popups/ pages open their windows, popups-allow/ pages work; must-pass 0, wake-ups 0', async () => {
  test.setTimeout(RUN_TIMEOUT_MS);
  const s = await startSession(server, extension.dir, contexts);
  const boots = await s.probe.boots();
  const observed = await runAll(s, GUARD_ROWS);
  expect(expectationFailures(observed, 'guardOff')).toEqual([]);
  expect(mustPassGate(observed, 'guardOff')).toEqual({ pass: true, failures: [] });
  expect(wakeGate(boots, await s.probe.boots())).toEqual({ pass: true, wakes: 0 });
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
});

for (const mode of ['smart', 'strict'] as const) {
  test(`J17 ${mode}: block-rate, must-pass and wake-up gates (pop-up notes §14)`, async () => {
    test.skip(GUARD_PENDING !== undefined, GUARD_PENDING);
    test.setTimeout(RUN_TIMEOUT_MS);
    const s = await startSession(server, extension.dir, contexts);
    await enableGuard(s, mode);
    const boots = await s.probe.boots();
    const observed = await runAll(s, GUARD_ROWS.filter((r) => r.pending === undefined), mode);
    expect(expectationFailures(observed, mode)).toEqual([]);
    expect(mode === 'smart' ? smartGate(observed).pass : strictGate(observed).pass).toBe(true);
    expect(mustPassGate(observed, mode)).toEqual({ pass: true, failures: [] });
    expect(wakeGate(boots, await s.probe.boots()).pass).toBe(true);
  });
}
