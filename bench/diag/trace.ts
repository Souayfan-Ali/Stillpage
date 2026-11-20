/**
 * `npx jiti bench/diag/trace.ts [--runs 5] [--variants full,no-registrations] [--page blank] [--top 25]`
 *
 * P2-47 CPU attribution by Chrome trace: loads one fixture page per launch with tracing on (renderer
 * timeline, V8, extensions) and sums the self-reported durations of complete events (`ph: X`) by name on
 * the loading renderer, then prints the events whose median total differs most between variants. Shows
 * where the extra time goes: script injection, parsing our files, pattern matching, or page work.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type BrowserContext } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '../../tests/fixtures/server/server.js';
import { pageUrl } from '../run/pages.js';
import { summarise } from '../run/stats.js';
import { reconciled, variantDir, type Config } from './launch.js';

const CATEGORIES = ['devtools.timeline', 'v8', 'v8.execute', 'blink', 'loading', 'extensions', 'disabled-by-default-devtools.timeline'].join(',');
const SETTLE_MS = 2_000;
const AFTER_LOAD_MS = 800;
const US_PER_MS = 1_000;
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly pid: number;
  readonly dur?: number;
}

async function traced(context: BrowserContext, url: string): Promise<Map<string, number>> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const events: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', (e) => {
    events.push(...(e.value as unknown as TraceEvent[]));
  });
  const done = new Promise<void>((resolve) => {
    cdp.once('Tracing.tracingComplete', () => {
      resolve();
    });
  });
  await cdp.send('Tracing.start', { categories: CATEGORIES, transferMode: 'ReportEvents' });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(AFTER_LOAD_MS);
  await cdp.send('Tracing.end');
  await done;
  await page.close();
  const totals = new Map<string, number>();
  for (const e of events) if (e.ph === 'X' && e.dur !== undefined) totals.set(e.name, (totals.get(e.name) ?? 0) + e.dur / US_PER_MS);
  return totals;
}

async function oneLaunch(config: Config, dir: string | null, server: FixtureServer, page: string): Promise<Map<string, number>> {
  const profile = await mkdtemp(path.join(tmpdir(), 'glassmere-diag-'));
  const ext = dir === null ? [] : [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`];
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', args: [...ext, ...server.chromiumArgs] });
  try {
    const worker = dir === null ? null : (context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
    if (worker !== null && config !== 'ubol') await reconciled(worker);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    for (const p of context.pages()) if (p.url() !== 'about:blank') await p.close().catch(() => undefined);
    return await traced(context, pageUrl(page));
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '5' }, variants: { type: 'string', default: 'none,full,no-registrations' }, page: { type: 'string', default: 'blank' }, top: { type: 'string', default: '25' } } });
  const configs = values.variants.split(',') as Config[];
  const root = await mkdtemp(path.join(tmpdir(), 'glassmere-diag-build-'));
  const server = await startFixtureServer();
  const runs = new Map<Config, Map<string, number>[]>(configs.map((c) => [c, []]));
  try {
    const dirs = new Map(await Promise.all(configs.map(async (c) => [c, await variantDir(c, root)] as const)));
    for (let r = 0; r < Number(values.runs); r += 1) for (const c of configs) runs.get(c)?.push(await oneLaunch(c, dirs.get(c) ?? null, server, values.page));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
  const names = [...new Set([...runs.values()].flatMap((rs) => rs.flatMap((m) => [...m.keys()])))];
  const median = (c: Config, n: string): number => summarise((runs.get(c) ?? []).map((m) => m.get(n) ?? 0)).p50 ?? 0;
  const spread = (n: string): number => Math.max(...configs.map((c) => median(c, n))) - Math.min(...configs.map((c) => median(c, n)));
  say(`| Trace event (ms, p50 of ${values.runs}, page ${values.page}) | ${configs.join(' | ')} |`);
  say(`|---|${configs.map(() => '---').join('|')}|`);
  for (const n of names.sort((a, b) => spread(b) - spread(a)).slice(0, Number(values.top))) say(`| ${n} | ${configs.map((c) => median(c, n).toFixed(2)).join(' | ')} |`);
}

main().catch((e: unknown) => {
  process.stderr.write(`diag failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
