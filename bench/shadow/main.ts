/**
 * `npm run bench:shadow -- [--extension <unpacked dir>] [--gestures <n>] [--out <dir>]`
 *
 * Shadow run of the pop-up guard (P2-61, testing notes §8): loads every `popups/` and `popups-allow/`
 * fixture through the local fixture server (never the live web), performs the row's scripted gesture
 * `--gestures` times, reads the guard's decision log (`logContract.ts`) and writes `shadow.json` and
 * `shadow.md`. `popups/` is the positive control: in a log-only build it must log would-blocks there,
 * otherwise the counter is not counting. Never gating (performance notes §5); exit 1 only on a malformed log.
 * The pinned real-site list and the nightly schedule are the owner's (NEEDS MAINTAINER).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { BrowserContext } from '@playwright/test';
import { loadPopupFixtures, type PopupRow } from '../../tests/fixtures/popupManifest.js';
import { startFixtureServer } from '../../tests/fixtures/server/server.js';
import { launchCorpus } from '../../tests/e2e/helpers/corpus.js';
import { perform } from '../../tests/e2e/helpers/popupRun.js';
import { aggregate, toMarkdown, type SiteSample } from './aggregate.js';
import { LOG_ATTRIBUTE, parseDecisionLog, type Decision } from './logContract.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SETTLE_MS = 600;
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function gesture(context: BrowserContext, row: PopupRow): Promise<readonly Decision[]> {
  const page = await context.newPage();
  const extra: { close: () => Promise<void> }[] = [];
  const track = (p: { close: () => Promise<void> }): void => {
    extra.push(p);
  };
  context.on('page', track);
  try {
    await page.goto(row.page, { waitUntil: 'load' });
    await perform(page, row.act);
    await page.waitForTimeout(SETTLE_MS);
    const raw = await page.evaluate((name) => document.documentElement.getAttribute(name), LOG_ATTRIBUTE).catch(() => null);
    const parsed = parseDecisionLog(raw);
    if (!parsed.ok) throw new Error(`${row.id}: ${parsed.error}`);
    return parsed.entries;
  } finally {
    context.off('page', track);
    await Promise.all([...extra, page].map((p) => p.close().catch(() => undefined)));
  }
}

async function sample(context: BrowserContext, row: PopupRow, gestures: number): Promise<SiteSample> {
  const entries: Decision[] = [];
  for (let i = 0; i < gestures; i += 1) entries.push(...(await gesture(context, row)));
  return { site: row.id, gestures, entries };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      extension: { type: 'string', default: path.join(ROOT, '.output/chrome-mv3') },
      gestures: { type: 'string', default: '1' },
      out: { type: 'string', default: path.join(ROOT, 'dist/bench/shadow') },
    },
  });
  const gestures = Number(values.gestures);
  if (!Number.isInteger(gestures) || gestures < 1) throw new Error('--gestures must be a positive integer');
  const rows = loadPopupFixtures().filter((r) => r.family === 'popups' || r.family === 'popups-allow');
  const server = await startFixtureServer();
  const profile = await mkdtemp(path.join(tmpdir(), 'glassmere-shadow-'));
  const context = await launchCorpus(profile, values.extension, server.chromiumArgs);
  try {
    const samples: SiteSample[] = [];
    for (const row of rows) samples.push(await sample(context, row, gestures));
    const report = aggregate(samples.filter((s) => s.site.startsWith('popups-allow/')));
    const control = aggregate(samples.filter((s) => s.site.startsWith('popups/')));
    const controlCounts = control.total.wouldBlock > 0;
    await mkdir(values.out, { recursive: true });
    await writeFile(path.join(values.out, 'shadow.json'), `${JSON.stringify({ report, control, controlCounts }, null, 1)}\n`);
    const md = `${toMarkdown(report)}\nPositive control (popups/): ${String(control.total.wouldBlock)} would-block in ${String(control.total.gestures)} gestures${controlCounts ? '' : ' — the build logs no decisions: use a log-only build (P2-57)'}.\n`;
    await writeFile(path.join(values.out, 'shadow.md'), md);
    say(md);
  } finally {
    await context.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`bench:shadow failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
