/**
 * Journeys J2, J3 and J4 (P1-46, testing notes §6) on the real build with the fixture corpus (P1-42/43):
 * filtering is Chrome's own persisted state (static rulesets, persistent registrations, dynamic
 * rules), so browsing never needs the worker. Wake-ups are counted with the boot counter the test copy
 * of the worker writes (D-17, S-22), read from a blank extension page that sends no message.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { loadFixtures, type FixtureEntry } from '../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { nonLoopbackPeers } from '../fixtures/server/sockets.js';
import { lastRunSince, openProbe, stopWorker, type ExtensionProbe } from './helpers/bootCounter.js';
import { startSession, type Session } from './helpers/session.js';
import { closeAll, expectNoSurvivors, RELOAD_ARGS } from './helpers/browser.js';
import { createDefaultSettings } from '../../src/core/state/defaults.js';
import { applySettings, createCorpusExtension, launchCorpus, type CorpusExtension } from './helpers/corpus.js';
import { expectFixture, rows, visit, type Visit } from './helpers/observe.js';

const ALL = loadFixtures();
/** Everything that runs at Standard with no per-fixture setup (levels and access are J5/J7). */
const BROWSE_FAMILIES = new Set(['net', 'redirect', 'cosmetic-specific', 'cosmetic-procedural', 'scriptlets', 'anti-adblock']);
const BROWSE = ALL.filter((f) => BROWSE_FAMILIES.has(f.family) && f.pending === undefined && f.setup?.siteLevels === undefined);
/** The generic-cosmetics rows (P2-24): Thorough on their hosts. */
const THOROUGH = ALL.filter((f) => (f.family === 'cosmetic-generic' || f.family === 'anti-adblock') && f.pending === undefined && Object.values(f.setup?.siteLevels ?? {}).includes('thorough'));
const byId = (id: string): FixtureEntry => {
  const found = ALL.find((f) => f.id === id);
  if (found === undefined) throw new Error(`${id} missing`);
  return found;
};
/** One page per kind of filtering: network block, surrogate, specific and procedural hiding, scriptlet. */
const ONE_OF_EACH = ['net/third-party', 'redirect/surrogate', 'cosmetic-specific/host-match', 'cosmetic-procedural/has', 'scriptlets/set-constant'].map(byId);
const BROWSE_TIMEOUT_MS = 180_000;
const POLL = { timeout: 10_000, intervals: [50, 100, 250] };

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
  try {
    await (server as FixtureServer | undefined)?.close();
    await (extension as CorpusExtension | undefined)?.remove();
  } finally {
    await expectNoSurvivors();
  }
});

const start = (profile?: string): Promise<Session> => startSession(server, extension.dir, contexts, profile);

async function launchOn(profile: string): Promise<BrowserContext> {
  const context = await launchCorpus(profile, extension.dir, [...server.chromiumArgs, ...RELOAD_ARGS]);
  contexts.add(context);
  return context;
}

/** Visits each fixture in turn (one tab at a time, so the server log belongs to one page). */
async function visitAll(context: BrowserContext, fixtures: readonly FixtureEntry[]): Promise<Visit[]> {
  const seen: Visit[] = [];
  for (const fixture of fixtures) seen.push(await visit(server, context, fixture));
  return seen;
}

/** Positive control: a command from an extension page must wake the stopped worker exactly once. */
async function expectOneBootOnCommand(s: Session, before: number): Promise<void> {
  await s.probe.page.evaluate(() => chrome.runtime.sendMessage({ v: 1, type: 'c/reconcile', id: 'j-ctl', payload: {} }));
  await expect.poll(() => s.probe.boots(), POLL).toBe(before + 1);
}

test('J2 browse the fixtures at Standard: blocked, hidden, scriptlets effective, 0 worker wake-ups', async () => {
  test.setTimeout(BROWSE_TIMEOUT_MS);
  const s = await start();
  await stopWorker(s.profile, s.id);
  const before = await s.probe.boots();

  for (const fixture of BROWSE) await expectFixture(server, s.context, fixture);

  // A wake starts at the navigation that causes it, long before the polled observations end.
  expect(await s.probe.boots(), 'worker boots while browsing').toBe(before);
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
  await expectOneBootOnCommand(s, before);
});

test(`J2 generic cosmetics at Thorough on their hosts (${THOROUGH.map((f) => f.id).join(', ')}), 0 worker wake-ups (P2-24)`, async () => {
  test.setTimeout(BROWSE_TIMEOUT_MS);
  const s = await start();
  const siteLevels = Object.assign({}, ...THOROUGH.map((f) => f.setup?.siteLevels ?? {})) as Record<string, string>;
  await applySettings(s.context, s.worker, s.id, { ...createDefaultSettings(), siteLevels });
  const registered = await s.probe.page.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['cosmetic-generic'] })).map((r) => r.runAt));
  expect(registered).toEqual(['document_idle']);
  await stopWorker(s.profile, s.id);
  const before = await s.probe.boots();
  // After the level change: Chrome may apply the new registration to new loads a little later (settle.ts).
  for (const fixture of THOROUGH) await expectFixture(server, s.context, fixture, fixture.expect, { afterChange: true });
  expect(await s.probe.boots(), 'worker boots while browsing').toBe(before);
  expect(nonLoopbackPeers(s.profile)).toEqual([]);
});

test('J2 at Standard the generic targets stay visible and no surveyor is registered (level gating, P2-25)', async () => {
  test.setTimeout(BROWSE_TIMEOUT_MS);
  const s = await start();
  expect(await s.probe.page.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['cosmetic-generic'] })).length)).toBe(0);
  for (const fixture of THOROUGH.filter((f) => f.family === 'cosmetic-generic')) {
    await expectFixture(server, s.context, fixture, [{ element: '.ad-banner', is: 'shown' }]);
  }
});

test('J3 worker stopped through CDP: filtering identical to the live worker, and it stays asleep', async () => {
  test.setTimeout(BROWSE_TIMEOUT_MS);
  const s = await start();
  const live = await visitAll(s.context, ONE_OF_EACH);

  await stopWorker(s.profile, s.id);
  const before = await s.probe.boots();
  const dead = await visitAll(s.context, ONE_OF_EACH);

  ONE_OF_EACH.forEach((fixture, i) => {
    const wanted = rows(fixture.expect, live[i]?.wanted ?? []);
    expect(rows(fixture.expect, live[i]?.actual ?? []), `${fixture.id} (live)`).toEqual(wanted);
    expect(rows(fixture.expect, dead[i]?.actual ?? []), `${fixture.id} (worker stopped)`).toEqual(wanted);
  });
  expect(await s.probe.boots(), 'worker boots while browsing').toBe(before);
  await expectOneBootOnCommand(s, before);
});

interface Persisted {
  readonly rulesets: readonly string[];
  readonly scripts: readonly string[];
  readonly dynamic: readonly number[];
}

/** What Chrome keeps across a restart, read from the probe page (no worker involved). */
function persisted(probe: ExtensionProbe): Promise<Persisted> {
  return probe.page.evaluate(async () => ({
    rulesets: (await chrome.declarativeNetRequest.getEnabledRulesets()).sort(),
    scripts: (await chrome.scripting.getRegisteredContentScripts()).map((r) => r.id).sort(),
    dynamic: (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id).sort((a, b) => a - b),
  }));
}

/**
 * J4 under the harness: `--load-extension` re-installs the extension on every launch (S-07, P1-14
 * deviation), so the restart's event is `onInstalled(install)`, which also resets runtime-enabled
 * rulesets to the manifest. What holds and is asserted: the first navigations after the restart are
 * filtered (network, specific hiding, scriptlet); the launch wakes the worker once and the navigations
 * wake it no further; the run ends in the pre-restart state. A store-installed restart, where
 * `onStartup` is the only event and its run restores the session-scoped registrations (ADR-020), is
 * `journeyPacked.spec.ts`.
 */
test('J4 browser restart: the first navigation is already filtered; the worker ends where it was', async () => {
  test.setTimeout(BROWSE_TIMEOUT_MS);
  const first = await start();
  const state = await persisted(first.probe);
  const before = await first.probe.boots();
  await first.context.close();

  const restartedAt = Date.now();
  const context = await launchOn(first.profile);
  // First navigations before anything else touches the extension.
  const firstPages = [byId('net/third-party'), byId('cosmetic-specific/host-match'), byId('scriptlets/set-constant')];
  const seen = await visitAll(context, firstPages);
  const firstLoadedAt = Date.now();
  firstPages.forEach((fixture, i) => {
    expect(rows(fixture.expect, seen[i]?.actual ?? []), fixture.id).toEqual(rows(fixture.expect, seen[i]?.wanted ?? []));
  });

  const probe = await openProbe(context, first.id);
  const run = await lastRunSince(probe, restartedAt, /^(startup|installed:\w+)$/);
  expect(run.status).not.toBe('failed');
  test.info().annotations.push({ type: 'restart run', description: `${run.reason} ${run.status}, started ${String(run.at - run.durationMs - restartedAt)} ms after launch; navigations done at ${String(firstLoadedAt - restartedAt)} ms` });
  expect(await persisted(probe)).toEqual(state);
  // Exactly the launch's wake: the navigations themselves woke nothing.
  await expect.poll(() => probe.boots(), POLL).toBe(before + 1);
  expect(nonLoopbackPeers(first.profile)).toEqual([]);
});

// J4 on a store-like packed install (`onStartup` the only event, its run restoring the session set, ADR-020) is in
// `journeyPacked.spec.ts` (D-33 spike, P2-09): a packed install kept in the profile, updated by Chromium's updater.
