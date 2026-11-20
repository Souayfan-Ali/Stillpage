/**
 * Browser-side measurements of the benchmark (P2-46, performance notes §3; method of S-15, harness v0): one
 * page load in a fresh tab — FCP, LCP, load event, renderer CPU (`ScriptDuration + TaskDuration`),
 * TBT from long tasks, requests and body bytes that reached the fixture server (all frames), requests
 * the top frame's network reports blocked — and per-launch figures: browser-process PSS and the extension
 * worker's JS heap (CDP `Runtime.getHeapUsage`, only while the worker runs; reading it wakes nothing).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext } from '@playwright/test';
import type { FixtureServer } from '../../tests/fixtures/server/server.js';
import type { Sample } from './report.js';

const SETTLE_AFTER_LOAD_MS = 800;
const LONG_TASK_MS = 50;
const BYTES_PER_KIB = 1024;

type PageMetrics = Omit<Sample, 'config' | 'run' | 'page'>;

/** Long tasks and LCP are observed from the first paint on, before any page script runs. */
const OBSERVERS = `(() => {
  self.__tbt = 0; self.__lcp = null;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) self.__tbt += Math.max(0, e.duration - ${String(LONG_TASK_MS)}); }).observe({ type: 'longtask', buffered: true });
  new PerformanceObserver((l) => { const e = l.getEntries().at(-1); if (e) self.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
})();`;


export async function loadPage(context: BrowserContext, server: FixtureServer, url: string): Promise<PageMetrics> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  let blocked = 0;
  try {
    await cdp.send('Performance.enable');
    await cdp.send('Network.enable');
    cdp.on('Network.loadingFailed', (e) => {
      if (e.blockedReason !== undefined || e.errorText.includes('BLOCKED_BY_CLIENT')) blocked += 1;
    });
    await page.addInitScript(OBSERVERS);
    server.clearLog();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(SETTLE_AFTER_LOAD_MS);
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const w = self as unknown as { __tbt: number; __lcp: number | null };
      return { fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, lcp: w.__lcp, load: nav?.loadEventEnd ?? null, tbt: w.__tbt };
    });
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = new Map(metrics.map((x) => [x.name, x.value]));
    const cpuMs = ((m.get('ScriptDuration') ?? 0) + (m.get('TaskDuration') ?? 0)) * 1000;
    return { ...timing, cpuMs, requests: server.log().length, blocked, kB: server.bytes() / BYTES_PER_KIB };
  } finally {
    await cdp.detach().catch(() => undefined);
    await page.close();
  }
}

const pss = (pid: number): number => {
  try {
    return Number(/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${String(pid)}/smaps_rollup`, 'utf8'))?.[1] ?? 0);
  } catch {
    return 0;
  }
};

/** PSS of the browser process launched on `profileDir` (S-15 method; Linux only, null elsewhere). */
export function browserPssKiB(profileDir: string): number | null {
  try {
    const lines = execFileSync('pgrep', ['-af', profileDir], { encoding: 'utf8' }).trim().split('\n');
    const browser = lines.find((l) => !l.includes('--type='));
    return browser === undefined ? null : pss(Number(browser.split(' ')[0]));
  } catch {
    return null;
  }
}

interface DevtoolsTarget {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

/** The worker's used JS heap in KiB over the local DevTools port, or null when no worker runs. */
export async function workerHeapKiB(profileDir: string, extensionId: string): Promise<number | null> {
  const port = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0] ?? '';
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as DevtoolsTarget[];
  const ws = targets.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`))?.webSocketDebuggerUrl;
  if (ws === undefined) return null;
  const socket = new WebSocket(ws);
  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    // The target sends events (e.g. `Inspector.workerScriptLoaded`) before the reply: wait for id 1.
    const reply = new Promise<{ id?: number; result?: { usedSize: number } }>((resolve) => {
      socket.onmessage = (e: MessageEvent<string>) => {
        const message = JSON.parse(e.data) as { id?: number; result?: { usedSize: number } };
        if (message.id === 1) resolve(message);
      };
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.getHeapUsage' }));
    const used = (await reply).result?.usedSize;
    return used === undefined ? null : used / BYTES_PER_KIB;
  } finally {
    socket.close();
  }
}
