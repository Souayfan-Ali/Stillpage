/**
 * `npx jiti bench/diag/memory.ts [--runs 3] [--variants full,no-registrations,…] [--out <dir>]`
 *
 * P2-47 memory diagnosis: for `none`, uBOL and each A/B variant of our build (`variants.ts`), fresh
 * profiles on Playwright's bundled Chromium against the local fixture server; waits for the install
 * reconcile, opens the blank fixture page, then reads PSS per process kind (browser, extension
 * renderer, page renderers, GPU, utility), the worker's used JS heap, and what Chrome
 * holds (registered scripts and their patterns, enabled rulesets). Writes `memory.json` and prints a table.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Worker } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '../../tests/fixtures/server/server.js';
import { summarise, type Summary } from '../run/stats.js';
import { workerHeapKiB } from '../run/measure.js';
import { pageUrl } from '../run/pages.js';
import { reconciled, variantDir, type Config } from './launch.js';
import { registrationsOf, scriptBytes, VARIANTS } from './variants.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SETTLE_MS = 3_000;
const KINDS = ['browser', 'extension', 'renderer', 'gpu', 'utility', 'all'] as const;
type Kind = (typeof KINDS)[number];

interface Reading {
  readonly pss: Readonly<Record<Kind, number>>;
  /** PSS of shared memory (`Pss_Shmem`): the user-script region lives there. */
  readonly shmem: Readonly<Record<Kind, number>>;
  readonly renderers: number;
  /** Duration of the install reconcile (`reconcile.last.durationMs`). */
  readonly reconcileMs: number | null;
  readonly heapKiB: number | null;
  readonly registered: number | null;
  readonly patterns: number | null;
  readonly rulesets: number | null;
}

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function rollup(pid: number): { pss: number; shmem: number } {
  try {
    const text = readFileSync(`/proc/${String(pid)}/smaps_rollup`, 'utf8');
    return { pss: Number(/^Pss:\s+(\d+)/m.exec(text)?.[1] ?? 0), shmem: Number(/^Pss_Shmem:\s+(\d+)/m.exec(text)?.[1] ?? 0) };
  } catch {
    return { pss: 0, shmem: 0 };
  }
}

function kindOf(cmd: string): Exclude<Kind, 'all'> {
  if (!cmd.includes('--type=')) return 'browser';
  if (cmd.includes('--type=renderer')) return cmd.includes('--extension-process') ? 'extension' : 'renderer';
  return cmd.includes('--type=gpu-process') ? 'gpu' : 'utility';
}

function processPss(profile: string): Pick<Reading, 'pss' | 'shmem' | 'renderers'> {
  const zero = (): Record<Kind, number> => ({ browser: 0, extension: 0, renderer: 0, gpu: 0, utility: 0, all: 0 });
  const [pss, shmem] = [zero(), zero()];
  let renderers = 0;
  const lines = execFileSync('pgrep', ['-af', profile], { encoding: 'utf8' }).trim().split('\n');
  for (const line of lines.filter((l) => l.includes('chrome'))) {
    const r = rollup(Number(line.split(' ')[0]));
    const kind = kindOf(line);
    if (kind === 'renderer') renderers += 1;
    pss[kind] += r.pss;
    pss.all += r.pss;
    shmem[kind] += r.shmem;
    shmem.all += r.shmem;
  }
  return { pss, shmem, renderers };
}

async function chromeState(worker: Worker): Promise<Pick<Reading, 'registered' | 'patterns' | 'rulesets' | 'reconcileMs'>> {
  return worker.evaluate(async () => {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    const rulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
    const last = (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] as { durationMs?: number } | undefined;
    return { registered: scripts.length, patterns: scripts.reduce((n, s) => n + (s.matches?.length ?? 0), 0), rulesets: rulesets.length, reconcileMs: last?.durationMs ?? null };
  });
}

async function measure(config: Config, dir: string | null, server: FixtureServer): Promise<Reading> {
  const profile = await mkdtemp(path.join(tmpdir(), 'glassmere-diag-'));
  const ext = dir === null ? [] : [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`];
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', args: [...ext, ...server.chromiumArgs, '--remote-debugging-port=0'] });
  try {
    const worker = dir === null ? null : (context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
    if (worker !== null && config !== 'ubol') await reconciled(worker);
    for (const p of context.pages()) if (p.url() !== 'about:blank') await p.close().catch(() => undefined);
    const page = await context.newPage();
    await page.goto(pageUrl('blank'));
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const state = worker === null || config === 'ubol' ? { registered: null, patterns: null, rulesets: null, reconcileMs: null } : await chromeState(worker);
    const heapKiB = worker === null ? null : await workerHeapKiB(profile, new URL(worker.url()).host);
    return { ...processPss(profile), heapKiB, ...state };
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

/** `summed / unique` MB of the script files the variant's registrations name. */
function summedScriptMB(dir: string): string {
  const b = scriptBytes(registrationsOf(readFileSync(path.join(dir, 'registrations.json'), 'utf8')), (f) => statSync(path.join(dir, f)).size);
  return `${(b.summed / 1e6).toFixed(1)} / ${(b.unique / 1e6).toFixed(2)}`;
}

const p50 = (s: Summary): string => (s.p50 === null ? '–' : (s.p50 / 1024).toFixed(1));

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { runs: { type: 'string', default: '3' }, variants: { type: 'string', default: ['none', 'ubol', ...VARIANTS].join(',') }, out: { type: 'string', default: path.join(ROOT, 'dist/bench/diag') } } });
  const configs = values.variants.split(',') as Config[];
  const runs = Number(values.runs);
  const root = await mkdtemp(path.join(tmpdir(), 'glassmere-diag-build-'));
  const server = await startFixtureServer();
  const loadBefore = loadavg();
  const readings = new Map<Config, Reading[]>(configs.map((c) => [c, []]));
  const bytes = new Map<Config, string>();
  try {
    const dirs = new Map(await Promise.all(configs.map(async (c) => [c, await variantDir(c, root)] as const)));
    for (const [c, dir] of dirs) if (dir !== null && c !== 'ubol') bytes.set(c, summedScriptMB(dir));
    for (let r = 0; r < runs; r += 1) for (const c of configs) readings.get(c)?.push(await measure(c, dirs.get(c) ?? null, server));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
  const rows: Record<string, unknown>[] = configs.map((c) => {
    const rs = readings.get(c) ?? [];
    return { config: c, ...Object.fromEntries(KINDS.map((k) => [k, summarise(rs.map((x) => x.pss[k]))])), heapKiB: summarise(rs.map((x) => x.heapKiB)), rendererShmem: summarise(rs.map((x) => x.shmem.renderer)), renderers: rs[0]?.renderers ?? null, reconcileMs: summarise(rs.map((x) => x.reconcileMs)), scriptMB: bytes.get(c) ?? null, registered: rs[0]?.registered ?? null, patterns: rs[0]?.patterns ?? null, rulesets: rs[0]?.rulesets ?? null };
  });
  await mkdir(values.out, { recursive: true });
  await writeFile(path.join(values.out, 'memory.json'), `${JSON.stringify({ runs, loadBefore, loadAfter: loadavg(), rows }, null, 1)}\n`);
  say(`load ${loadBefore.map((x) => x.toFixed(2)).join(' / ')} → ${loadavg().map((x) => x.toFixed(2)).join(' / ')}; PSS p50 in MiB over ${String(runs)} runs`);
  say('| Config | Browser | Ext. renderer | Page renderers (n; of it shmem) | GPU | Utility | All | Worker heap (MiB) | Scripts | Patterns | Rulesets | Script MB summed / unique | Install reconcile (ms) |');
  say('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const s = (k: string): string => p50(row[k] as Summary);
    say(`| ${row['config'] as string} | ${s('browser')} | ${s('extension')} | ${s('renderer')} (${String(row['renderers'])}; ${s('rendererShmem')}) | ${s('gpu')} | ${s('utility')} | ${s('all')} | ${s('heapKiB')} | ${String(row['registered'])} | ${String(row['patterns'])} | ${String(row['rulesets'])} | ${(row['scriptMB'] as string | null) ?? '–'} | ${String((row['reconcileMs'] as Summary).p50 ?? '–')} |`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`diag failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
