/**
 * Harness of the hostile-page suite (J15, P2-42, testing notes §6, security notes §9). The real build, with test data
 * compiled by the real compiler for the hostile hosts (`createCorpusExtension`: a scriptlet, specific,
 * `:style()` and procedural filters, generic data, and one listed pop-up destination), the boot counter,
 * every hostname mapped to the local fixture server, and a CDP network log on every target from the
 * first instruction (J16 style). Each spec file runs one session; its last check is that the extension
 * made no request at all while the page attacked it. Nothing here ships.
 */
import { expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { FixtureEntry } from '../../fixtures/manifest.js';
import type { PopupRow } from '../../fixtures/popupManifest.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server/server.js';
import { nonLoopbackPeers } from '../../fixtures/server/sockets.js';
import { closeAll, expectNoSurvivors } from '../helpers/browser.js';
import { extensionInitiated, startNetworkLog, type NetworkLog } from '../helpers/cdpNetwork.js';
import { createCorpusExtension, type CorpusExtension } from '../helpers/corpus.js';
import { startSession, type Session } from '../helpers/session.js';

export const HOST = 'hostile.example';
const ORIGIN = `https://${HOST}`;
/** The listed pop-up destination (`$popup`), redirected to `blocked.html` by the reconciler (P2-55). */
export const LISTED = 'listed.hostile-dest.example';
/** A session's install reconcile and a picker run take seconds under load: a bound, not a budget. */
export const SESSION_TIMEOUT_MS = 240_000;
export const POLL = { timeout: 15_000, intervals: [50, 100, 250] };

const page = (name: string): string => `${ORIGIN}/hostile/${name}.html`;

/** One entry per filter family the probes attack (the corpus compiler's input; `expect` is not read here). */
const entry = (id: string, family: FixtureEntry['family'], filters: readonly string[], file = 'cosmetics'): FixtureEntry => ({
  id: `hostile/${id}`,
  family,
  page: page(file),
  file: `hostile/${file}.html`,
  filters: [...filters],
  expect: [{ global: '__hostile', is: true }],
});

const HOSTILE_FIXTURES: readonly FixtureEntry[] = [
  entry('dispatcher', 'scriptlets', [`${HOST}##+js(set, adsEnabled, false)`], 'dispatcher'),
  entry('cosmetic', 'cosmetic-specific', [`${HOST}##.ad-box`, `${HOST}##.sticky:style(position: static !important)`]),
  entry('procedural', 'cosmetic-procedural', [`${HOST}##.card:has-text(Sponsored)`]),
  entry('generic', 'cosmetic-generic', ['##.generic-ad']),
];

/** One `$popup` row, so the build lists `LISTED` as a destination (`popup-destinations.json`). */
const POPUP_ROW: PopupRow = {
  id: 'popup-destinations/hostile',
  family: 'popup-destinations',
  technique: 'D1',
  page: page('blocked-opener'),
  file: 'hostile/blocked-opener.html',
  act: { none: true },
  target: `https://${LISTED}/`,
  filters: [`||${LISTED}^$popup`],
  expect: { guardOff: 'blocked' },
};

export interface Hostile {
  readonly server: FixtureServer;
  readonly session: Session;
  readonly log: NetworkLog;
  readonly context: BrowserContext;
  readonly worker: Worker;
}

let extension: CorpusExtension | undefined;
let server: FixtureServer | undefined;
let log: NetworkLog | undefined;
const contexts = new Set<BrowserContext>();

/** Starts the server, the extension, the session and the network log (call from `beforeAll`). */
export async function startHostile(): Promise<Hostile> {
  server = await startFixtureServer();
  extension = await createCorpusExtension(HOSTILE_FIXTURES, [POPUP_ROW]);
  const session = await startSession(server, extension.dir, contexts);
  log = await startNetworkLog(session.profile);
  return { server, session, log, context: session.context, worker: session.worker };
}

/** The suite's J16 row: the extension made no request outside its package, and no socket left the machine. */
export function expectNoExtensionNetwork(h: Hostile): void {
  const all = h.log.requests();
  expect(all.length, 'the logger saw the hostile pages').toBeGreaterThan(0);
  // The picker panel and the blocked page load through their `use_dynamic_url` address (another
  // `chrome-extension://` origin, still our package): not a network request.
  expect(extensionInitiated(all, h.session.id).filter((r) => !r.url.startsWith('chrome-extension://'))).toEqual([]);
  expect(nonLoopbackPeers(h.session.profile)).toEqual([]);
}

/** Closes everything the session opened and checks that no browser or profile survives (call from `afterAll`). */
export async function stopHostile(): Promise<void> {
  try {
    await log?.close();
    await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
    contexts.clear();
    await closeAll();
    await server?.close();
    await extension?.remove();
  } finally {
    log = undefined;
    server = undefined;
    extension = undefined;
    await expectNoSurvivors();
  }
}

/** Opens one hostile page from `tests/fixtures/hostile/` in a fresh tab. */
export async function openHostile(h: Hostile, name: string, origin = ORIGIN): Promise<Page> {
  const tab = await h.context.newPage();
  await tab.goto(`${origin}/hostile/${name}.html`, { waitUntil: 'load' });
  return tab;
}

/** Global names of the page's window (to show no extension global appeared). */
export const globalNames = (tab: Page): Promise<readonly string[]> => tab.evaluate(() => Object.getOwnPropertyNames(window).sort());

type PageHelpers = Record<string, ((...a: unknown[]) => unknown) | undefined>;

/** Calls one of the fixture page's own `window.__*` helpers with `args`; resolves with its (serialisable) result. */
export const call = (tab: Page, name: string, ...args: unknown[]): Promise<unknown> =>
  tab.evaluate(([n, a]) => (window as unknown as PageHelpers)[n]?.(...a), [name, args] as const);

/** Sets the pop-up policy "Strict" for `host` from the toolbar panel page, as the user does, and waits for the guard. */
export async function strictSite(h: Hostile, host: string): Promise<void> {
  const panel = await h.context.newPage();
  await panel.goto(`chrome-extension://${h.session.id}/popup.html?tabId=1`);
  const answer: unknown = await panel.evaluate((hostname) => chrome.runtime.sendMessage({ v: 1, type: 'c/setSitePopupPolicy', id: 'j15', payload: { hostname, policy: 'strict' } }), host);
  expect(answer).toMatchObject({ ok: true });
  await panel.close();
  const guard = (): Promise<number> => h.worker.evaluate(async (pattern) => (await chrome.scripting.getRegisteredContentScripts())
    .filter((s) => ['popup-sentinel', 'popup-shim', 'popup-strict'].includes(s.id) && (s.matches ?? []).includes(pattern)).length, `*://*.${host}/*`);
  await expect.poll(guard, POLL).toBe(3);
}
