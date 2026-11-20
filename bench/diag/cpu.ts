/**
 * `npx jiti bench/diag/cpu.ts [--runs 9] [--variants none,ubol,full,…] [--pages blank,adheavy-3] [--out <dir>]`
 *
 * P2-47 CPU attribution: the benchmark's page loads (`run/measure.ts`) on `none`, uBOL and A/B variants of
 * our build (`variants.ts`), interleaved per round, fresh profile per launch, after the install reconcile.
 * Prints renderer CPU and FCP p50 (p25–p75) per variant and page, with the machine load.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '../../tests/fixtures/server/server.js';
import { loadPage } from '../run/measure.js';
import { pageUrl } from '../run/pages.js';
import { summarise, type Summary } from '../run/stats.js';
import { reconciled, variantDir, type Config } from './launch.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SETTLE_MS = 2_000;
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

type Row = Readonly<{ config: Config; page: string; cpuMs: number; fcp: number | null }>;

async function oneLaunch(config: Config, dir: string | null, server: FixtureServer, pages: readonly string[]): Promise<Row[]> {
  const profile = await mkdtemp(path.join(tmpdir(), 'glassmere-diag-'));
  const ext = dir === null ? [] : [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`];
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', args: [...ext, ...server.chromiumArgs] });
  try {
    const worker = dir === null ? null : (context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
    if (worker !== null && config !== 'ubol') await reconciled(worker);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    for (const p of context.pages()) if (p.url() !== 'about:blank') await p.close().catch(() => undefined);
    await loadPage(context, server, pageUrl('article'));
    const rows: Row[] = [];
    for (const page of pages) {
      const m = await loadPage(context, server, pageUrl(page));
      rows.push({ config, page, cpuMs: m.cpuMs ?? 0, fcp: m.fcp });
    }
    return rows;
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

const spread = (s: Summary): string => (s.p50 === null ? '–' : `${s.p50.toFixed(1)} (${(s.p25 ?? 0).toFixed(1)}–${(s.p75 ?? 0).toFixed(1)})`);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string', default: '9' },
      variants: { type: 'string', default: 'none,ubol,full,no-registrations,unique-js-only,one-host-each,two-registrations' },
      pages: { type: 'string', default: 'blank,adheavy-3' },
      out: { type: 'string', default: path.join(ROOT, 'dist/bench/diag') },
    },
  });
  const configs = values.variants.split(',') as Config[];
  const pages = values.pages.split(',');
  const root = await mkdtemp(path.join(tmpdir(), 'glassmere-diag-build-'));
  const server = await startFixtureServer();
  const loadBefore = loadavg();
  const rows: Row[] = [];
  try {
    const dirs = new Map(await Promise.all(configs.map(async (c) => [c, await variantDir(c, root)] as const)));
    for (let r = 0; r < Number(values.runs); r += 1) for (const c of configs) rows.push(...(await oneLaunch(c, dirs.get(c) ?? null, server, pages)));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
  await mkdir(values.out, { recursive: true });
  await writeFile(path.join(values.out, 'cpu.json'), `${JSON.stringify({ loadBefore, loadAfter: loadavg(), rows }, null, 1)}\n`);
  say(`load ${loadBefore.map((x) => x.toFixed(2)).join(' / ')} → ${loadavg().map((x) => x.toFixed(2)).join(' / ')}; p50 (p25–p75), ${values.runs} runs`);
  say(`| Config | ${pages.map((p) => `${p} CPU (ms) | ${p} FCP`).join(' | ')} |`);
  for (const c of configs) {
    const cells = pages.map((p) => {
      const of = rows.filter((r) => r.config === c && r.page === p);
      return `${spread(summarise(of.map((r) => r.cpuMs)))} | ${spread(summarise(of.map((r) => r.fcp)))}`;
    });
    say(`| ${c} | ${cells.join(' | ')} |`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`diag failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
