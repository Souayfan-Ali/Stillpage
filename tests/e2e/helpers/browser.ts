/**
 * Browser harness for the worker E2E (P1-14): bundled Chromium, throwaway profile, local fixture
 * server; in-place updates through CDP `Extensions.loadUnpacked` (S-07/S-17); site access changed the
 * way the extensions menu does it (`developerPrivate` on chrome://extensions, S-10). Every launch is
 * tracked so the suite can assert that no browser process and no profile dir survives.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { TEMP_PREFIX } from './fixtureExtension.js';
import { closeOnboardingTab, expectsOnboardingTab } from './onboardingTab.js';

/** Lets CDP `Extensions.loadUnpacked` run over a second, local-only connection. */
export const RELOAD_ARGS = ['--remote-debugging-port=0', '--enable-unsafe-extension-debugging'];
const WORKER_TIMEOUT_MS = 15_000;

const profiles = new Set<string>();
const contexts = new Set<BrowserContext>();
/** How long closed browsers may take to exit before they count as survivors: a bound, not a budget; at load 46 Chrome took over 3 s to exit after `close()` (P2-47 stability). */
const SURVIVOR_WAIT_MS = 20_000;
const SURVIVOR_POLL_MS = 100;

export async function newProfile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  profiles.add(dir);
  return dir;
}

/**
 * Launches and tracks the context, so `closeAll` can close it whatever the test did. On a fresh
 * install the first-run tab is closed first (D-46) unless `keepOnboarding` (J1).
 */
export interface LaunchOptions {
  readonly keepOnboarding?: boolean;
  /** Added to the browser's environment (panelFit.spec.ts pins the fonts with `FONTCONFIG_FILE`). */
  readonly env?: Readonly<Record<string, string>>;
}

export async function launch(profileDir: string, extensionDir: string, options: LaunchOptions = {}): Promise<BrowserContext> {
  const onboarding = options.keepOnboarding !== true && expectsOnboardingTab(profileDir, extensionDir);
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, ...RELOAD_ARGS],
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  });
  contexts.add(context);
  context.once('close', () => contexts.delete(context));
  if (onboarding) await closeOnboardingTab(context);
  return context;
}

/** Closes every context still open and removes every profile; for `afterEach` (review HIGH 2). */
export async function closeAll(): Promise<void> {
  await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
  await Promise.all([...profiles].map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function extensionWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  return existing ?? context.waitForEvent('serviceworker', { timeout: WORKER_TIMEOUT_MS });
}

export async function removeProfile(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** In-place update of the unpacked extension; resolves with the new worker and the call time. */
export async function updateInPlace(context: BrowserContext, profileDir: string, extensionDir: string): Promise<{ worker: Worker; startedAt: number }> {
  const port = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0] ?? '';
  const cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const cdp = await cdpBrowser.newBrowserCDPSession();
    const next = context.waitForEvent('serviceworker', { timeout: WORKER_TIMEOUT_MS });
    const startedAt = Date.now();
    await cdp.send('Extensions.loadUnpacked' as never, { path: extensionDir } as never);
    return { worker: await next, startedAt };
  } finally {
    await cdpBrowser.close();
  }
}

export type HostAccess = 'ON_ALL_SITES' | 'ON_CLICK';

/** Sets the user's site-access choice for the extension, as the extensions menu does. */
export async function setHostAccess(context: BrowserContext, extensionId: string, hostAccess: HostAccess): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions');
    await page.evaluate(
      ([id, access]) =>
        (globalThis as unknown as { chrome: { developerPrivate: { updateExtensionConfiguration: (c: object) => Promise<void> } } }).chrome.developerPrivate.updateExtensionConfiguration({
          extensionId: id,
          hostAccess: access,
        }),
      [extensionId, hostAccess] as const,
    );
  } finally {
    await page.close();
  }
}

export interface FixtureServer {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

const PAGE = '<!doctype html><title>fixture</title><script src="/ad.js"></script><p>fixture</p>';
const AD = 'window.adLoaded = true;\n';

/** Local page with an "ad" script, on 127.0.0.1 only. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const body = req.url === '/ad.js' ? AD : PAGE;
    res.writeHead(200, { 'content-type': req.url === '/ad.js' ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function survivors(): string[] {
  const left = [...profiles].filter((dir) => existsSync(dir));
  let running = '';
  try {
    running = execFileSync('pgrep', ['-af', TEMP_PREFIX], { encoding: 'utf8' });
  } catch {
    running = '';
  }
  const mine = running.split('\n').filter((line) => line !== '' && [...profiles].some((dir) => line.includes(dir)));
  return [...left, ...mine];
}

/** Rejects when a browser started for one of our profiles still runs, or a profile dir is left, after a short grace period for exiting children. */
export async function expectNoSurvivors(): Promise<void> {
  const deadline = Date.now() + SURVIVOR_WAIT_MS;
  let found = survivors();
  while (found.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SURVIVOR_POLL_MS));
    found = survivors();
  }
  if (found.length > 0) throw new Error(`survivors: ${found.join('\n')}`);
}
