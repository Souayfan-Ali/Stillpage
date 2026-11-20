/**
 * Fixture families net/, redirect/, levels/ and permissions/ (P1-42, testing notes §3), driven by
 * `tests/fixtures/fixtures.json`: every row is loaded through the HTTPS fixture server under its real
 * hostname, with the built worker reconciling the fixtures' rules and registrations, and each expected
 * observation is checked. The browser must open no socket to a non-loopback address.
 */
import { test, expect, type BrowserContext, type Worker } from '@playwright/test';
import { createDefaultSettings } from '../../src/core/state/defaults.js';
import { loadFixtures, type FixtureEntry } from '../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { nonLoopbackPeers, processCount } from '../fixtures/server/sockets.js';
import { applySettings, createCorpusExtension, launchCorpus, reconciledSince, setSiteAccess, type CorpusExtension } from './helpers/corpus.js';
import { closeAll, expectNoSurvivors, extensionWorker, newProfile } from './helpers/browser.js';
import { expectFixture as expectObserved } from './helpers/observe.js';

const ALL = loadFixtures();
const byFamily = (family: string): readonly FixtureEntry[] => ALL.filter((f) => f.family === family);
const MS_PER_S = 1_000;
const PAUSE_POLL = { timeout: 30_000, intervals: [250, 500] };

let server: FixtureServer;
let extension: CorpusExtension;
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
  extension = await createCorpusExtension(ALL);
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

interface Session {
  readonly context: BrowserContext;
  readonly worker: Worker;
  readonly id: string;
  readonly profile: string;
}

async function start(): Promise<Session> {
  const profile = await newProfile();
  const since = Date.now();
  const context = await launchCorpus(profile, extension.dir, server.chromiumArgs);
  contexts.add(context);
  const worker = await extensionWorker(context);
  await reconciledSince(worker, since, /^installed:/);
  return { context, worker, id: new URL(worker.url()).host, profile };
}

function expectFixture(context: BrowserContext, fixture: FixtureEntry, expectations = fixture.expect): Promise<void> {
  return expectObserved(server, context, fixture, expectations);
}

/** After a level, pause or access change: Chrome may apply it to new loads a little later (`helpers/settle.ts`). */
function expectAfterChange(context: BrowserContext, fixture: FixtureEntry, expectations = fixture.expect): Promise<void> {
  return expectObserved(server, context, fixture, expectations, { afterChange: true });
}

function settingsFor(fixture: FixtureEntry, now: number): object {
  const host = new URL(fixture.page).hostname;
  const pauseSeconds = fixture.setup?.pauseSeconds;
  return {
    ...createDefaultSettings(),
    siteLevels: fixture.setup?.siteLevels ?? {},
    pauses: pauseSeconds === undefined ? {} : { [host]: { until: now + pauseSeconds * MS_PER_S } },
  };
}

test('net/ and redirect/: every row of fixtures.json, no socket leaves the machine', async () => {
  const session = await start();
  for (const fixture of [...byFamily('net'), ...byFamily('redirect')]) await expectFixture(session.context, fixture);
  expect(processCount(session.profile)).toBeGreaterThan(0);
  expect(nonLoopbackPeers(session.profile)).toEqual([]);
});

test('levels/: Off, Light, Standard, Thorough and inheritance on the same page', async () => {
  const session = await start();
  for (const fixture of byFamily('levels').filter((f) => f.setup?.pauseSeconds === undefined)) {
    await applySettings(session.context, session.worker, session.id, settingsFor(fixture, Date.now()));
    await expectAfterChange(session.context, fixture);
  }
  expect(nonLoopbackPeers(session.profile)).toEqual([]);
});

test('levels/pause-expiry: Off during the pause, back on after the alarm', async () => {
  const fixture = byFamily('levels').find((f) => f.id === 'levels/pause-expiry');
  if (fixture === undefined) throw new Error('levels/pause-expiry missing');
  const session = await start();
  const since = Date.now();
  await applySettings(session.context, session.worker, session.id, settingsFor(fixture, since));
  await expectAfterChange(session.context, fixture, fixture.setup?.duringPause ?? []);
  await expect
    .poll(
      () =>
        session.worker.evaluate(
          async () =>
            (
              (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] as {
                reason: string;
              }
            ).reason,
        ),
      PAUSE_POLL,
    )
    .toBe('pause-expiry');
  await reconciledSince(session.worker, since, /^pause-expiry$/);
  await expectAfterChange(session.context, fixture);
});

for (const fixture of byFamily('permissions')) {
  test(`${fixture.id}: ${fixture.note ?? 'all-sites access'}`, async () => {
    const session = await start();
    for (const access of (fixture.setup?.access ?? ['all']).filter((a, i) => i > 0 || a !== 'all')) {
      const since = Date.now();
      await setSiteAccess(session.context, session.id, access, fixture.page);
      await reconciledSince(session.worker, since, /^permissions$/);
    }
    await expectAfterChange(session.context, fixture);
    expect(nonLoopbackPeers(session.profile)).toEqual([]);
  });
}

/**
 * P1-43 families: cosmetic-specific/, cosmetic-procedural/, cosmetic-generic/, scriptlets/,
 * anti-adblock/. Fixtures only for now: a row whose feature does not exist yet is skipped with the
 * `pending` reason from fixtures.json (the task that builds it removes the marker); rows that need
 * nothing but network rules run.
 */
for (const fixture of ['cosmetic-specific', 'cosmetic-procedural', 'cosmetic-generic', 'scriptlets', 'anti-adblock'].flatMap(byFamily)) {
  test(`${fixture.id}${fixture.pending === undefined ? '' : ' (pending)'}`, async () => {
    test.skip(fixture.pending !== undefined, fixture.pending);
    const session = await start();
    // Generic hiding is Thorough only (P2-24): those rows name the level of their host.
    if (fixture.setup?.siteLevels === undefined) await expectFixture(session.context, fixture);
    else {
      await applySettings(session.context, session.worker, session.id, settingsFor(fixture, Date.now()));
      await expectAfterChange(session.context, fixture);
    }
    expect(nonLoopbackPeers(session.profile)).toEqual([]);
  });
}
