/**
 * P1-11 / P1-35 / P1-37 budgets in real Chrome with a full-scale registration set: no-op wake ≤ 150 ms
 * p95 (ADR-012); after an in-place update (D-19, provisional): scriptlets ≤ 500 ms, all registrations
 * ≤ 3.0 s, window ≤ 3.5 s; install → fully registered ≤ 5 s (performance notes §2.2). Two sets: the synthetic
 * one of P1-11 (600 registrations, a third MAIN, 36,000 patterns) and **the build's own catalog**
 * (P1-35: ≈ 983 registrations, ≈ 35,800 patterns; D-23 asked for this re-run). The real run also
 * times an Off/Light toggle (`updateContentScripts` of the shards holding one host, P1-34 risk).
 * Durations are measured inside the worker from the start of the run. Opt-in (`E2E_SCALE=1`): on a
 * loaded machine the post-update numbers sit at the budget edge, so the default suite would be flaky.
 * Milestones are asserted on the median; with `E2E_QUIET=1` (a quiet machine) on the p95.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { createDefaultSettings } from '../../src/core/state/defaults.js';
import { applySettings } from './helpers/corpus.js';
import { BUILD_DIR, createFixtureExtension, type FixtureExtension } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, extensionWorker, launch, newProfile, removeProfile, startFixtureServer, updateInPlace, type FixtureServer } from './helpers/browser.js';

const SCALE = { registrations: 600, hostsEach: 60 };
const NO_OP_RUNS = 20;
const UPDATES = 5;
const TOGGLES = 6;
const NO_OP_BUDGET_MS = 150;
const SCRIPTLETS_AFTER_UPDATE_MS = 500;
const RECONCILE_AFTER_UPDATE_MS = 3_000;
const UPDATE_WINDOW_MS = 3_500;
const INSTALL_BUDGET_MS = 5_000;
const POLL = { timeout: 30_000, intervals: [50, 100, 250] };

interface Last {
  readonly reason: string;
  readonly status: string;
  readonly at: number;
  readonly durationMs: number;
  readonly scriptletsMs?: number;
  readonly dropped?: readonly string[];
}

const last = (worker: Worker): Promise<Last | undefined> =>
  worker.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] as Last | undefined);

async function settled(worker: Worker, reason: string, after = 0): Promise<Last> {
  await expect
    .poll(async () => {
      const l = await last(worker);
      return l?.reason === reason && l.at >= after;
    }, POLL)
    .toBe(true);
  const result = await last(worker);
  if (result === undefined) throw new Error('no reconcile outcome');
  return result;
}

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Infinity;
const p95 = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? Infinity;

test.skip(process.env['E2E_SCALE'] !== '1', 'full-scale budget run is opt-in: E2E_SCALE=1');

let server: FixtureServer;
test.beforeAll(async () => {
  server = await startFixtureServer();
});
test.afterEach(async () => {
  await closeAll();
});
test.afterAll(async () => {
  await server.close();
  await expectNoSurvivors();
});

async function noOpWakes(context: BrowserContext, worker: Worker, id: string): Promise<number[]> {
  const noOp: number[] = [];
  const page = await context.newPage();
  for (let i = 0; i < NO_OP_RUNS; i += 1) {
    const before = Date.now();
    await page.goto(`chrome-extension://${id}/e2e.html`);
    const outcome = await settled(worker, 'command', before);
    expect(outcome.status).toBe('unchanged');
    noOp.push(outcome.durationMs);
  }
  await page.close();
  return noOp;
}

interface UpdateRuns {
  readonly worker: Worker;
  readonly reconcile: number[];
  readonly scriptlets: number[];
  readonly windows: number[];
  readonly navigations: number[];
}

async function updates(context: BrowserContext, profile: string, extension: FixtureExtension): Promise<UpdateRuns> {
  const runs = { reconcile: [] as number[], scriptlets: [] as number[], windows: [] as number[], navigations: [] as number[] };
  const tab = await context.newPage();
  let worker = await extensionWorker(context);
  for (let i = 0; i < UPDATES; i += 1) {
    await extension.setVersion(`0.0.${String(i + 2)}`);
    const updated = await updateInPlace(context, profile, extension.dir);
    worker = updated.worker;
    const t0 = Date.now();
    await tab.goto(`${server.origin}/`);
    runs.navigations.push(Date.now() - t0);
    const outcome = await settled(worker, 'installed:update', updated.startedAt);
    expect(outcome.status).toBe('applied');
    runs.reconcile.push(outcome.durationMs);
    runs.scriptlets.push(outcome.scriptletsMs ?? Infinity);
    runs.windows.push(outcome.at - updated.startedAt);
  }
  await tab.close();
  return { ...runs, worker };
}

interface Measured {
  readonly context: BrowserContext;
  readonly worker: Worker;
  readonly id: string;
  readonly summary: string;
  readonly profile: string;
}

/** Installs, then measures no-op wakes and in-place updates against the budgets. */
async function measure(extension: FixtureExtension, expected: number, version: string): Promise<Measured> {
  const profile = await newProfile();
  const context = await launch(profile, extension.dir);
  const first = await extensionWorker(context);
  const id = new URL(first.url()).host;
  const install = await settled(first, 'installed:install');
  expect(install.status).toBe('applied');
  expect(install.dropped ?? []).toEqual([]);
  // The pop-up guard's `popup-*` registrations (on the list-designated Strict sites by default, P2-58) are not shards.
  const ids = await first.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((r) => r.id));
  expect(ids.filter((r) => !r.startsWith('popup-')).length).toBe(expected);
  const noOp = await noOpWakes(context, first, id);
  const runs = await updates(context, profile, extension);
  await extension.setVersion(version);
  const summary =
    `install ${String(install.durationMs)} ms (scriptlets ${String(install.scriptletsMs)}); no-op p95 ${String(p95(noOp))} ms (n=${String(NO_OP_RUNS)}); after update ` +
    `scriptlets ${runs.scriptlets.join('/')} ms, all ${runs.reconcile.join('/')} ms, window ${runs.windows.join('/')} ms; ` +
    `navigation during the call ${runs.navigations.join('/')} ms`;
  test.info().annotations.push({ type: 'budgets', description: summary });
  // Soft: every figure is recorded even when one sits over its (provisional) budget.
  expect.soft(install.durationMs).toBeLessThan(INSTALL_BUDGET_MS);
  expect.soft(p95(noOp)).toBeLessThan(NO_OP_BUDGET_MS);
  const statistic = process.env['E2E_QUIET'] === '1' ? p95 : median;
  expect.soft(statistic(runs.scriptlets)).toBeLessThan(SCRIPTLETS_AFTER_UPDATE_MS);
  expect.soft(statistic(runs.reconcile)).toBeLessThan(RECONCILE_AFTER_UPDATE_MS);
  expect.soft(statistic(runs.windows)).toBeLessThan(UPDATE_WINDOW_MS);
  return { context, worker: runs.worker, id, summary, profile };
}

test('synthetic set (600 registrations): no-op wake and post-update reconcile within budget', { tag: '@perf' }, async () => {
  test.setTimeout(180_000);
  const extension = await createFixtureExtension({ scale: SCALE });
  try {
    const run = await measure(extension, SCALE.registrations + 1, '0.0.1');
    await run.context.close();
    await removeProfile(run.profile);
  } finally {
    await extension.remove();
  }
});

interface CatalogFile {
  readonly packs: Readonly<Record<string, { readonly default: boolean }>>;
}
interface RegistrationsFile {
  readonly packs: Readonly<Record<string, readonly { readonly id: string; readonly hosts: readonly string[] }[]>>;
}

/**
 * Off, then back to the default, alternating, on one host of an ISOLATED shard (Off and Light give the
 * same registrations, so alternating them would not touch Chrome); each run's duration in the worker.
 */
async function toggles(run: Measured, host: string): Promise<number[]> {
  const durations: number[] = [];
  for (let i = 0; i < TOGGLES; i += 1) {
    const before = Date.now();
    await applySettings(run.context, run.worker, run.id, { ...createDefaultSettings(), siteLevels: i % 2 === 0 ? { [host]: 'off' } : {} }, 'e2e.html');
    const outcome = await settled(run.worker, 'command', before);
    expect(outcome.status).toBe('applied');
    durations.push(outcome.durationMs);
  }
  return durations;
}

/** `c/setSiteLevel` from the toolbar panel page, Off then back: round trip to the answer (D-25). */
async function panelToggles(run: Measured, host: string): Promise<number[]> {
  const page = await run.context.newPage();
  await page.goto(`chrome-extension://${run.id}/popup.html`);
  const durations: number[] = [];
  for (let i = 0; i < TOGGLES; i += 1) {
    const ms = await page.evaluate(async ([hostname, level]) => {
      const t0 = performance.now();
      const answer = await chrome.runtime.sendMessage<object, { ok: boolean }>({ v: 1, type: 'c/setSiteLevel', id: 'p', payload: { hostname, level } });
      if (!answer.ok) throw new Error('refused');
      return performance.now() - t0;
    }, [host, i % 2 === 0 ? 'off' : 'inherit'] as const);
    durations.push(Math.round(ms));
    await settled(run.worker, 'command', Date.now() - 1);
  }
  await page.close();
  return durations;
}

test('the build\'s own registrations (P1-35/P1-37, D-23): budgets, and the Off/Light toggle cost', { tag: '@perf' }, async () => {
  test.setTimeout(300_000);
  const catalog = JSON.parse(await readFile(path.join(BUILD_DIR, 'catalog.json'), 'utf8')) as CatalogFile;
  const file = JSON.parse(await readFile(path.join(BUILD_DIR, 'registrations.json'), 'utf8')) as RegistrationsFile;
  const regs = Object.entries(catalog.packs).filter(([, p]) => p.default).flatMap(([id]) => file.packs[id] ?? []);
  const host = regs.find((r) => r.id.startsWith('iso:'))?.hosts[0] ?? '';
  const extension = await createFixtureExtension({ real: true });
  const { version } = JSON.parse(await readFile(path.join(extension.dir, 'manifest.json'), 'utf8')) as { version: string };
  try {
    const run = await measure(extension, regs.length, version);
    const durations = await toggles(run, host);
    const answers = await panelToggles(run, host);
    test.info().annotations.push({
      type: 'toggle',
      description: `${String(regs.length)} registrations, ${String(regs.reduce((n, r) => n + r.hosts.length, 0))} patterns; Off ↔ Standard toggle of ${host} ` +
        `(${String(regs.filter((r) => r.hosts.includes(host)).length)} registration(s) updated): whole run ${durations.join('/')} ms; ` +
        `panel answer (D-25, ≤ 150 ms) ${answers.join('/')} ms`,
    });
    await run.context.close();
    await removeProfile(run.profile);
  } finally {
    await extension.remove();
  }
});

/** D-29 / D-38 triggers (P2-47): no-op wake p95 with default settings > 90 ms, or with every pack on > 120 ms. */
const NO_OP_ALL_PACKS_TRIGGER_MS = 120;

/** Every non-regional optional pack plus the largest regional: the most that can be on together (D-35). */
function everyPack(catalog: CatalogFile, file: RegistrationsFile): Record<string, boolean> {
  const optional = Object.entries(catalog.packs).filter(([, p]) => !p.default).map(([id]) => id);
  const patterns = (id: string): number => (file.packs[id] ?? []).reduce((n, r) => n + r.hosts.length, 0);
  const regional = optional.filter((id) => id.startsWith('reg-')).sort((a, b) => patterns(b) - patterns(a));
  const on = [...optional.filter((id) => !id.startsWith('reg-') && id !== 'gpc'), ...regional.slice(0, 1)];
  return Object.fromEntries(on.map((id) => [id, true]));
}

test('every pack on (D-29, D-38): no-op wake p95 against the fingerprint-skip trigger', { tag: '@perf' }, async () => {
  test.setTimeout(300_000);
  const catalog = JSON.parse(await readFile(path.join(BUILD_DIR, 'catalog.json'), 'utf8')) as CatalogFile;
  const file = JSON.parse(await readFile(path.join(BUILD_DIR, 'registrations.json'), 'utf8')) as RegistrationsFile;
  const packs = everyPack(catalog, file);
  const extension = await createFixtureExtension({ real: true });
  const profile = await newProfile();
  try {
    const context = await launch(profile, extension.dir);
    const worker = await extensionWorker(context);
    const id = new URL(worker.url()).host;
    await settled(worker, 'installed:install');
    const before = Date.now();
    await applySettings(context, worker, id, { ...createDefaultSettings(), packs }, 'e2e.html');
    const applied = await settled(worker, 'command', before);
    expect(applied.dropped ?? []).toEqual([]);
    const registered = await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
    const noOp = await noOpWakes(context, worker, id);
    test.info().annotations.push({
      type: 'every pack',
      description: `${Object.keys(packs).join(',')}: ${String(registered)} registrations; apply ${String(applied.durationMs)} ms; no-op median ${String(median(noOp))}, p95 ${String(p95(noOp))} ms (trigger ${String(NO_OP_ALL_PACKS_TRIGGER_MS)})`,
    });
    expect.soft(p95(noOp)).toBeLessThanOrEqual(NO_OP_ALL_PACKS_TRIGGER_MS);
    await context.close();
  } finally {
    await removeProfile(profile);
    await extension.remove();
  }
});
