/**
 * Benchmark configurations (performance notes §4): `none` (no extension), `ours` (the unpacked build in
 * `.output/chrome-mv3`, copied with the S-22 boot counter prepended to its worker so wake-ups can be
 * counted — test data, never shipped), `ours-guard` (the same with the pop-up guard switched on as the
 * user does, `c/setPopupMode` from the toolbar panel page; performance notes §2.5 "blank page, guard on"), and `ubol` (uBO Lite's published unpacked release from the
 * cache, `npm run oracle:fetch`; skipped with a reason when absent). Every copy lives in a temp dir removed afterwards.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { withBootCounter } from '../../tests/e2e/helpers/bootCounter.js';
import { defaultRegistrations, registrationsOf, scriptBytes } from '../diag/variants.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BUILD_DIR = path.join(ROOT, '.output/chrome-mv3');
const UBOL_DIR = path.join(ROOT, '.cache/spikes/ubol/unpacked');
export const CONFIG_NAMES = ['none', 'ours', 'ours-guard', 'ubol'] as const;
export type ConfigName = (typeof CONFIG_NAMES)[number];
/** What `npm run bench` runs without `--configs`; `ours-guard` is asked for by name. */
export const DEFAULT_CONFIGS: readonly ConfigName[] = ['none', 'ours', 'ubol'];
/** How long the guard's registrations may take after the mode change (a bound, not a budget). */
const GUARD_REGISTERED_MS = 60_000;
const GUARD_POLL_MS = 250;

export interface Config {
  readonly name: ConfigName;
  /** Unpacked extension to load; null for `none`. */
  readonly dir: string | null;
  /** Size of what is measured (the copy for `ours` adds only the counter), KiB. */
  readonly packageKiB: number;
  /** `ours` only: the copy's worker counts its own starts (read from `fx.html`). */
  readonly countsBoots: boolean;
  readonly version: string;
  /** Script bytes the registrations name, summed over registrations and unique (KiB); `ours` only. */
  readonly scriptKiB?: { readonly summed: number; readonly unique: number };
  /** Runs after the settle, before any timed load (e.g. switching the guard on). */
  readonly afterSettle?: (context: BrowserContext, extensionId: string) => Promise<void>;
  readonly cleanup: () => Promise<void>;
}

const BLANK_PAGE = '<!doctype html><meta charset="utf-8"><title>bench</title>';
const NOTHING = (): Promise<void> => Promise.resolve();

function kib(dir: string): number {
  return Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0]);
}

async function versionOf(dir: string): Promise<string> {
  return (JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { version: string }).version;
}

/** The guard on, as the user does: `c/setPopupMode` from the panel page, then its scripts registered. */
async function guardOn(context: BrowserContext, id: string): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${id}/popup.html?tabId=1`);
    const answer = await page.evaluate<{ ok?: boolean }>(() => chrome.runtime.sendMessage({ v: 1, type: 'c/setPopupMode', id: 'bench-guard', payload: { mode: 'smart' } }));
    if (answer.ok !== true) throw new Error(`guard not switched on: ${JSON.stringify(answer)}`);
    const registered = (): Promise<boolean> => page.evaluate(async () => {
      const ids = (await chrome.scripting.getRegisteredContentScripts()).map((r) => r.id);
      return ids.includes('popup-sentinel') && ids.includes('popup-shim');
    });
    for (let waited = 0; !(await registered()); waited += GUARD_POLL_MS) {
      if (waited >= GUARD_REGISTERED_MS) throw new Error('guard scripts not registered');
      await page.waitForTimeout(GUARD_POLL_MS);
    }
  } finally {
    await page.close();
  }
}

async function ours(name: 'ours' | 'ours-guard' = 'ours'): Promise<Config> {
  if (!existsSync(path.join(BUILD_DIR, 'manifest.json'))) throw new Error(`no build in ${BUILD_DIR}: run npm run build first`);
  const root = await mkdtemp(path.join(tmpdir(), 'glassmere-bench-'));
  const dir = path.join(root, 'ext');
  await cp(BUILD_DIR, dir, { recursive: true });
  await writeFile(path.join(dir, 'background.js'), withBootCounter(await readFile(path.join(dir, 'background.js'), 'utf8')));
  await writeFile(path.join(dir, 'fx.html'), BLANK_PAGE);
  const registrations = registrationsOf(await readFile(path.join(dir, 'registrations.json'), 'utf8'));
  const bytes = scriptBytes(defaultRegistrations(registrations, await readFile(path.join(dir, 'catalog.json'), 'utf8')), (f) => statSync(path.join(dir, f)).size);
  const scriptKiB = { summed: Math.round(bytes.summed / 1024), unique: Math.round(bytes.unique / 1024) };
  const cleanup = (): Promise<void> => rm(root, { recursive: true, force: true });
  return { name, dir, packageKiB: kib(BUILD_DIR), countsBoots: true, version: await versionOf(dir), scriptKiB, ...(name === 'ours-guard' && { afterSettle: guardOn }), cleanup };
}

/** The requested configurations, and the ones that could not be prepared with the reason. */
export async function prepare(names: readonly ConfigName[]): Promise<{ configs: Config[]; skipped: { config: string; reason: string }[] }> {
  const configs: Config[] = [];
  const skipped: { config: string; reason: string }[] = [];
  for (const name of names) {
    if (name === 'none') configs.push({ name, dir: null, packageKiB: 0, countsBoots: false, version: '-', cleanup: NOTHING });
    else if (name === 'ours' || name === 'ours-guard') configs.push(await ours(name));
    else if (existsSync(path.join(UBOL_DIR, 'manifest.json'))) {
      configs.push({ name, dir: UBOL_DIR, packageKiB: kib(UBOL_DIR), countsBoots: false, version: await versionOf(UBOL_DIR), cleanup: NOTHING });
    } else skipped.push({ config: name, reason: `uBOL release not found in ${UBOL_DIR} (run npm run oracle:fetch)` });
  }
  return { configs, skipped };
}
