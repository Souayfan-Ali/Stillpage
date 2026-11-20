/**
 * Journey J4 on a packed, store-like install, plus the packed half of S-17 (D-33 spike in P2-09). The corpus build is installed as a packed extension (no `--load-extension`), then
 * updated by Chromium's own updater to a ruleset-only release made with the real `repack()` (P2-01) and
 * packed as a CRX3 with the same throwaway key. Afterwards a browser restart must fire `onStartup` only, and
 * its run must report `unchanged`.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type BrowserContext } from '@playwright/test';
import { repack } from '../../compiler/release/repack.js';
import { readZip, writeZip } from '../../compiler/release/zip.js';
import { loadFixtures } from '../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { nonLoopbackPeers } from '../fixtures/server/sockets.js';
import { lastRunSince, openProbe, type ExtensionProbe } from './helpers/bootCounter.js';
import { closeAll, expectNoSurvivors } from './helpers/browser.js';
import { createCorpusExtension, type CorpusExtension } from './helpers/corpus.js';
import { installPacked, launchPacked, packCrx, packedKey, readTree, startUpdateServer, writeTree, type UpdateServer } from './helpers/packed.js';
import { navigate } from './helpers/observe.js';
import { createThrowawayProfile, removeThrowawayProfiles } from './helpers/throwawayProfile.js';

const ALL = loadFixtures();
const BASE_VERSION = '1.0.317.600';
const NEXT_VERSION = '1.0.318.600';
const NEW_HOST = 'j4-packed-update.example';
const NEW_PAGE = `https://${NEW_HOST}/page`;
const JOURNEY_TIMEOUT_MS = 120_000;

let server: FixtureServer;
let updates: UpdateServer;
let extension: CorpusExtension;
let work: string;
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
  updates = await startUpdateServer();
  extension = await createCorpusExtension(ALL);
  work = await mkdtemp(path.join(tmpdir(), 'glassmere-packed-'));
});

test.afterEach(async () => {
  await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
  contexts.clear();
  await closeAll();
});

test.afterAll(async () => {
  try {
    await (server as FixtureServer | undefined)?.close();
    await (updates as UpdateServer | undefined)?.close();
    await (extension as CorpusExtension | undefined)?.remove();
    await rm(work, { recursive: true, force: true });
    await removeThrowawayProfiles();
  
  } finally {
    await expectNoSurvivors();
  }
});

/** The fixture server maps every host to itself; the update server's IP literal must stay out of that map. */
const args = (): readonly string[] =>
  server.chromiumArgs.map((a) => (a.startsWith('--host-resolver-rules=') ? `${a}, EXCLUDE 127.0.0.1` : a));

async function launch(profile: string, withUpdates: boolean): Promise<BrowserContext> {
  const context = await launchPacked(profile, args(), withUpdates);
  contexts.add(context);
  return context;
}

/** The full release as it would be published: the corpus build with its key, update URL and a scheme version. */
async function fullRelease(key: string): Promise<string> {
  const dir = path.join(work, 'v1');
  const files = new Map(await readTree(extension.dir));
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json'))) as Record<string, unknown>;
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify({ ...manifest, version: BASE_VERSION, key, update_url: updates.url })));
  await writeTree(dir, files);
  return dir;
}

/** The ruleset release: `repack()` of the full release with one new block rule in `fx.json`. */
async function rulesetRelease(base: string): Promise<string> {
  const zip = writeZip([...(await readTree(base))].map(([p, data]) => ({ path: p, data })));
  const rules = JSON.parse(await readFile(path.join(base, 'rulesets/fx.json'), 'utf8')) as { id: number }[];
  const added = { id: Math.max(...rules.map((r) => r.id)) + 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: `||${NEW_HOST}^`, resourceTypes: ['main_frame'] } };
  const candidate = repack({ base: zip, rulesets: new Map([['rulesets/fx.json', new TextEncoder().encode(JSON.stringify([...rules, added]))]]), version: NEXT_VERSION });
  const dir = path.join(work, 'v2');
  await writeTree(dir, new Map(readZip(candidate).map((e) => [e.path, e.data])));
  await writeFile(path.join(work, 'candidate.zip'), candidate);
  return dir;
}

async function persisted(probe: ExtensionProbe): Promise<unknown> {
  return probe.page.evaluate(async () => ({
    rulesets: (await chrome.declarativeNetRequest.getEnabledRulesets()).sort(),
    scripts: (await chrome.scripting.getRegisteredContentScripts()).map((r) => r.id).sort(),
    dynamic: (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id).sort((a, b) => a - b),
  }));
}

test('J4 packed install: a ruleset-only update through the updater, then a restart fires onStartup only and restores the session-scoped registrations', async () => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const key = await packedKey(work);
  const v1 = await fullRelease(key.publicKey);
  const crx = await packCrx(await rulesetRelease(v1), key);
  const profile = await createThrowawayProfile();
  await (await launch(profile, false)).close();
  await installPacked(profile, v1, key.id);

  // Session 1: the packed install runs; the store-like updater installs the ruleset release.
  const context = await launch(profile, true);
  const probe = await openProbe(context, key.id);
  expect(await probe.page.evaluate(() => chrome.runtime.getManifest().version)).toBe(BASE_VERSION);
  expect(await navigate(context, NEW_PAGE)).toBe('loaded');
  // Offered only now: Chromium's updater also checks by itself at startup.
  updates.offer(key.id, NEXT_VERSION, crx);
  // Chromium's updater downloads and verifies the CRX, then holds it back while an extension page is open
  // (`onUpdateAvailable`); reloading applies it, as going idle would.
  const checkedAt = Date.now();
  const available = await probe.page.evaluate(() => new Promise<string>((resolve) => {
    chrome.runtime.onUpdateAvailable.addListener((d) => { resolve(d.version); });
    void chrome.runtime.requestUpdateCheck();
  }));
  expect(available).toBe(NEXT_VERSION);
  const appliedAt = Date.now();
  await probe.page.evaluate(() => { chrome.runtime.reload(); }).catch(() => undefined);
  const after = await openProbe(context, key.id);
  const update = await lastRunSince(after, checkedAt, /^installed:update$/);
  expect(update.status).toBe('applied');
  test.info().annotations.push({ type: 'packed update (fixture scale)', description: `download + verify ${String(appliedAt - checkedAt)} ms; reload → run ended ${String(update.at - appliedAt)} ms; run ${String(update.durationMs)} ms; scriptlets ${String(update.scriptletsMs)} ms` });
  expect(await after.page.evaluate(() => chrome.runtime.getManifest().version)).toBe(NEXT_VERSION);
  expect(await navigate(context, NEW_PAGE)).toBe('blocked');
  const state = await persisted(after);
  expect(updates.hits().filter((h) => h.startsWith('/updates.xml')).length).toBeGreaterThan(0);
  expect(nonLoopbackPeers(profile)).toEqual([]);
  await context.close();

  // Session 2: a plain restart of a packed install. onStartup is the only event. Chrome kept only the persistent
  // core tier (ADR-020, P2-65); the startup run registers the session-scoped rest, so it reports `applied`.
  const restartedAt = Date.now();
  const restarted = await launch(profile, false);
  // The first navigation, before anything touches the extension, is already filtered by the new rule.
  expect(await navigate(restarted, NEW_PAGE)).toBe('blocked');
  const again = await openProbe(restarted, key.id);
  const startup = await lastRunSince(again, restartedAt, /^startup$/);
  expect(startup.status).toBe('applied');
  expect(await again.page.evaluate(() => chrome.runtime.getManifest().version)).toBe(NEXT_VERSION);
  expect(await persisted(again)).toEqual(state);
  // Background networking was on for the updater: still nothing left the machine.
  expect(nonLoopbackPeers(profile)).toEqual([]);
});
