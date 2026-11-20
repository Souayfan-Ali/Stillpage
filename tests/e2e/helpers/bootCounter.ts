/**
 * Worker wake-ups for the journeys (P1-46, D-17, S-22): CDP target events do not report a restarted
 * extension worker, so the test copy of the worker counts its own starts. `withBootCounter` prepends
 * one statement to the copied `background.js` (test data, never shipped; shipped code never uses
 * `storage.local`); an extension page that sends no message reads it, so reading wakes nothing.
 * The worker is stopped the S-22 way, with CDP `Target.closeTarget` on its service-worker target.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';

const BOOTS_KEY = 'e2e.boots';
/**
 * A bound on waiting for a run or a stopped worker, not a budget (see `corpus.ts`): J4's `startup` run after a
 * packed restart was not seen within 30 s at load 42 (P2-47 stability).
 */
const POLL = { timeout: 60_000, intervals: [50, 100, 250] };

const COUNTER = `chrome.storage.local.get(${JSON.stringify(BOOTS_KEY)}).then((x) => chrome.storage.local.set({ ${JSON.stringify(BOOTS_KEY)}: (x[${JSON.stringify(BOOTS_KEY)}] ?? 0) + 1 }));\n`;

/** The worker script with the boot counter as its first statement (the build is a classic IIFE). */
export function withBootCounter(workerScript: string): string {
  return COUNTER + workerScript;
}

export interface LastRun {
  readonly reason: string;
  readonly status: string;
  readonly at: number;
  readonly durationMs: number;
  readonly scriptletsMs?: number;
}

/** A blank extension page of ours (`fx.html`): reads storage without ever messaging the worker. */
export interface ExtensionProbe {
  readonly page: Page;
  readonly boots: () => Promise<number>;
  readonly last: () => Promise<LastRun | undefined>;
}

export async function openProbe(context: BrowserContext, extensionId: string): Promise<ExtensionProbe> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/fx.html`);
  return {
    page,
    boots: () => page.evaluate(async (key) => ((await chrome.storage.local.get(key))[key] as number | undefined) ?? 0, BOOTS_KEY),
    last: () => page.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] as LastRun | undefined),
  };
}

/** Waits until a reconcile whose reason matches ended after `since`, read from the probe page. */
export async function lastRunSince(probe: ExtensionProbe, since: number, reason: RegExp): Promise<LastRun> {
  await expect
    .poll(async () => {
      const last = await probe.last();
      return last !== undefined && last.at >= since && reason.test(last.reason);
    }, POLL)
    .toBe(true)
    .catch(async (error: unknown) => {
      // Name what was there instead, so a miss says whether no run came or another one came after it.
      const seen = await probe.last().catch(() => undefined);
      throw new Error(`no ${String(reason)} run since ${String(since)}; reconcile.last is ${JSON.stringify(seen)}`, { cause: error });
    });
  const last = await probe.last();
  if (last === undefined) throw new Error('reconcile.last vanished');
  return last;
}

async function withBrowserCdp<T>(profileDir: string, run: (send: (method: string, params?: object) => Promise<unknown>) => Promise<T>): Promise<T> {
  const port = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0] ?? '';
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const cdp = await browser.newBrowserCDPSession();
    return await run((method, params) => cdp.send(method as never, params as never));
  } finally {
    await browser.close();
  }
}

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
}

async function workerTargets(send: (method: string, params?: object) => Promise<unknown>, extensionId: string): Promise<readonly TargetInfo[]> {
  const { targetInfos } = (await send('Target.getTargets')) as { targetInfos: TargetInfo[] };
  return targetInfos.filter((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`));
}

/**
 * Stops the extension's worker and waits until Chrome lists no worker target for it, so a test that
 * browses "with the worker dead" never passes vacuously. Needs the browser launched with `RELOAD_ARGS`.
 */
export async function stopWorker(profileDir: string, extensionId: string): Promise<void> {
  await withBrowserCdp(profileDir, async (send) => {
    const targets = await workerTargets(send, extensionId);
    if (targets.length === 0) throw new Error('no worker target to stop');
    for (const t of targets) await send('Target.closeTarget', { targetId: t.targetId });
    await expect.poll(async () => (await workerTargets(send, extensionId)).length, POLL).toBe(0);
  });
}
