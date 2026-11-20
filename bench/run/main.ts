/**
 * `npm run bench -- [--runs 9] [--configs none,ours,ubol|ours-guard] [--pages blank,article,…] [--out <dir>]`
 *
 * Benchmark harness v1 (P2-46, performance notes §4, §7): `--runs` rounds, each launching every configuration on a
 * fresh profile of Playwright's bundled Chromium (interleaved, so machine load hits all alike); per launch a settle, a warm-up load, then every page of `tests/fixtures/perf/`
 * once through the HTTPS fixture server (every hostname mapped to loopback, nothing leaves the
 * machine — checked per run). Writes `result.json` and `summary.md` (`dist/bench/<time>/` by default)
 * and prints the summary. Needs `npm run build` for `ours`. Never gating (performance notes §3); the nightly job
 * and the `bench-data` trend branch are the owner's (NEEDS MAINTAINER).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type BrowserContext } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '../../tests/fixtures/server/server.js';
import { nonLoopbackPeers } from '../../tests/fixtures/server/sockets.js';
import { CONFIG_NAMES, DEFAULT_CONFIGS, prepare, type Config, type ConfigName } from './configs.js';
import { browserPssKiB, loadPage, workerHeapKiB } from './measure.js';
import { BENCH_PAGES, pageUrl } from './pages.js';
import { buildReport, toMarkdown, type Env, type Sample } from './report.js';
import { summarise } from './stats.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
/** Time for an extension to install and reconcile before timing starts (S-15 used 5 s). */
const SETTLE_MS = 5_000;
const DEFAULT_RUNS = 9;
const BOOTS_KEY = 'e2e.boots';
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

interface RunResult {
  readonly samples: Sample[];
  readonly pss: number | null;
  readonly heap: number | null;
  readonly wakes: number | null;
}

function list<T extends string>(raw: string, allowed: readonly T[], what: string): T[] {
  const items = raw.split(',').filter((x) => x !== '');
  const bad = items.filter((x) => !(allowed as readonly string[]).includes(x));
  if (bad.length > 0) throw new Error(`unknown ${what}: ${bad.join(', ')} (allowed: ${allowed.join(', ')})`);
  return items as T[];
}

async function launch(profile: string, config: Config, server: FixtureServer): Promise<BrowserContext> {
  const ext = config.dir === null ? [] : [`--disable-extensions-except=${config.dir}`, `--load-extension=${config.dir}`];
  return chromium.launchPersistentContext(profile, { channel: 'chromium', args: [...ext, ...server.chromiumArgs, '--remote-debugging-port=0'] });
}

async function boots(context: BrowserContext, id: string): Promise<number> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${id}/fx.html`);
    return await page.evaluate(async (key) => ((await chrome.storage.local.get(key))[key] as number | undefined) ?? 0, BOOTS_KEY);
  } finally {
    await page.close();
  }
}

async function oneRun(config: Config, server: FixtureServer, pages: readonly string[], run: number): Promise<RunResult> {
  const profile = await mkdtemp(path.join(tmpdir(), 'glassmere-bench-profile-'));
  const context = await launch(profile, config, server);
  try {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    for (const p of context.pages()) if (p.url() !== 'about:blank') await p.close().catch(() => undefined);
    const id = config.dir === null ? '' : new URL(context.serviceWorkers()[0]?.url() ?? 'chrome-extension://none/').host;
    await config.afterSettle?.(context, id);
    const heap = config.dir === null ? null : await workerHeapKiB(profile, id);
    const before = config.countsBoots ? await boots(context, id) : null;
    await loadPage(context, server, pageUrl('article'));
    const samples: Sample[] = [];
    for (const page of pages) samples.push({ config: config.name, page, run, ...(await loadPage(context, server, pageUrl(page))) });
    const wakes = before === null ? null : (await boots(context, id)) - before;
    const pss = browserPssKiB(profile);
    const leaks = nonLoopbackPeers(profile);
    if (leaks.length > 0) throw new Error(`a socket left the machine: ${leaks.join(', ')}`);
    return { samples, pss, heap, wakes };
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

function environment(runs: number, loadBefore: readonly number[]): Env {
  const git = (args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  return {
    commit: `${git(['rev-parse', '--short', 'HEAD'])}${git(['status', '--porcelain']) === '' ? '' : '+dirty'}`,
    node: process.version,
    chromium: chromium.executablePath().split(path.sep).find((s) => s.startsWith('chromium-')) ?? 'bundled',
    os: `${platform()} ${release()}`,
    cpu: `${cpus()[0]?.model ?? 'unknown'} × ${String(cpus().length)}`,
    loadBefore: loadBefore.map((x) => Math.round(x * 100) / 100),
    loadAfter: loadavg().map((x) => Math.round(x * 100) / 100),
    runs,
    at: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string', default: String(DEFAULT_RUNS) },
      configs: { type: 'string', default: DEFAULT_CONFIGS.join(',') },
      pages: { type: 'string', default: BENCH_PAGES.join(',') },
      out: { type: 'string' },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  const pages = list(values.pages, BENCH_PAGES, 'page');
  const loadBefore = loadavg();
  const { configs, skipped } = await prepare(list<ConfigName>(values.configs, CONFIG_NAMES, 'config'));
  const server = await startFixtureServer();
  const samples: Sample[] = [];
  const extras: Record<string, Record<string, ReturnType<typeof summarise> | number>> = {};
  try {
    // Runs outer, configurations inner: a load change on a shared machine hits every configuration alike.
    const results = new Map<ConfigName, RunResult[]>(configs.map((c) => [c.name, []]));
    for (let run = 0; run < runs; run += 1) {
      for (const config of configs) results.get(config.name)?.push(await oneRun(config, server, pages, run));
      say(`run ${String(run + 1)} / ${String(runs)} done`);
    }
    for (const config of configs) {
      const rs = results.get(config.name) ?? [];
      samples.push(...rs.flatMap((r) => r.samples));
      extras[config.name] = { packageKiB: config.packageKiB, browserPssKiB: summarise(rs.map((r) => r.pss)), workerHeapKiB: summarise(rs.map((r) => r.heap)), wakeUps: summarise(rs.map((r) => r.wakes)), ...(config.scriptKiB && { scriptSummedKiB: config.scriptKiB.summed, scriptUniqueKiB: config.scriptKiB.unique }) };
    }
  } finally {
    await server.close();
    await Promise.all(configs.map((c) => c.cleanup()));
  }
  const builds = configs.filter((c) => c.dir !== null).map((c) => `${c.name} ${c.version}`).join(', ');
  const report = buildReport(samples, skipped, { ...environment(runs, loadBefore), builds }, extras);
  const out = values.out ?? path.join(ROOT, 'dist/bench', report.env.at.replace(/[:.]/g, '-'));
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'result.json'), `${JSON.stringify(report, null, 1)}\n`);
  const md = toMarkdown(report);
  await writeFile(path.join(out, 'summary.md'), md);
  say(md);
  say(`written to ${out}`);
}

main().catch((e: unknown) => {
  process.stderr.write(`bench failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
