/**
 * The fixture corpus in the real build (P1-42): the built extension plus test data made from
 * `fixtures.json` — the fixtures' filters compiled by the real compiler post-pass (P1-44 replaced the
 * hand conversions), split into a safe ruleset `fx` and an unsafe one `fx-x` (off in the manifest, as
 * the build gate requires), a catalog with one pack and the
 * fixtures' content-script registrations (a probe that marks `<html data-probe="ran">`), and the
 * surrogate, and the S-22 boot counter prepended to the built worker (`bootCounter.ts`). The worker
 * enables all of it through its normal reconcile. Nothing here ships.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { FixtureEntry } from '../../fixtures/manifest.js';
import { compileContent } from '../../helpers/compileContent.js';
import { compileFilters } from '../../helpers/compileFilters.js';
import { compilePopups } from '../../helpers/compilePopups.js';
import type { PopupRow } from '../../fixtures/popupManifest.js';
import { withBootCounter } from './bootCounter.js';
import { BUILD_DIR, TEMP_PREFIX } from './fixtureExtension.js';
import { closeOnboardingTab, expectsOnboardingTab } from './onboardingTab.js';

const PROBE = "document.documentElement.dataset.probe = 'ran';\n";
const SURROGATE = "self.__surrogate = 'fx-noop';\n";
const BLANK_PAGE = '<!doctype html><meta charset="utf-8"><title>fx</title>';
/**
 * How long to wait for a reconcile to finish: a bound on waiting for the right condition, not a budget
 * (budgets: `npm run test:perf`). The install reconcile of the real build (983 registrations) took > 15 s
 * at load 48 (P2-47 stability, 2026-11-14).
 */
const POLL = { timeout: 60_000, intervals: [50, 100, 250] };

/** Every fixture's filters through the real compiler post-pass (P1-44): `fx` safe, `fx-x` unsafe. */
async function rulesets(fixtures: readonly FixtureEntry[]): Promise<{ safe: readonly object[]; unsafe: readonly object[] }> {
  const lines = [...new Set(fixtures.flatMap((f) => f.filters))].sort();
  return compileFilters(lines);
}

function registrations(fixtures: readonly FixtureEntry[]): object[] {
  const hostSets = new Set(fixtures.flatMap((f) => f.setup?.registrations ?? []).map((r) => JSON.stringify([...r.hosts].sort())));
  return [...hostSets].map((hosts, i) => ({
    id: `iso:fx:${String(i + 1)}`,
    world: 'ISOLATED',
    js: ['cs/fx-probe.js'],
    hosts: JSON.parse(hosts) as string[],
  }));
}

/**
 * The fixtures' cosmetic and scriptlet filters through the real content compiler (P1-34…P1-37): shard
 * data, scriptlet code, the procedural engine and their registrations, as `lists:build` emits them.
 * The fixture pages' hosts stand in for the hosts a real build names (observed entity expansion, D-20).
 */
async function content(fixtures: readonly FixtureEntry[], popups: readonly PopupRow[]): Promise<{ files: ReadonlyMap<string, string>; registrations: readonly object[]; generic: boolean; genericOff: readonly string[] }> {
  const popupLines = popups.flatMap((r) => (r.filters ?? []).filter((f) => !isPopupFilter(f)));
  const lines = [...new Set([...fixtures.flatMap((f) => f.filters), ...popupLines])].sort();
  const hosts = [...fixtures.map((f) => f.page), ...popups.filter((r) => r.filters !== undefined).map((r) => r.page)].map((u) => new URL(u).hostname);
  const compiled = await compileContent(lines, 'ads', hosts);
  return {
    files: compiled.files,
    registrations: compiled.build.registrations.get('ads') ?? [],
    // P2-24/P2-25: the fixtures' generic filters as the `ads` pack's generic data, and their `$generichide` hosts.
    generic: Object.hasOwn(compiled.build.generic.packs, 'ads'),
    genericOff: [...new Set(compiled.build.generic.off)].sort(),
  };
}

const isPopupFilter = (f: string): boolean => /\$(?:.*,)?popup(?:,|$)/.test(f);

/** The pop-up rows' `$popup` filters as the `popups` ruleset (P2-61), always on like the shipped one. */
function popupsRuleset(popups: readonly PopupRow[]): ReturnType<typeof compilePopups> {
  return compilePopups([...new Set(popups.flatMap((r) => (r.filters ?? []).filter(isPopupFilter)))].sort());
}

export interface CorpusExtension {
  readonly dir: string;
  readonly remove: () => Promise<void>;
}

export async function createCorpusExtension(fixtures: readonly FixtureEntry[], popups: readonly PopupRow[] = []): Promise<CorpusExtension> {
  const root = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  const dir = path.join(root, 'ext');
  await cp(BUILD_DIR, dir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const { safe, unsafe } = await rulesets(fixtures);
  const compiled = await content(fixtures, popups);
  const popupBuild = await popupsRuleset(popups);
  const files: Readonly<Record<string, string>> = {
    'manifest.json': JSON.stringify({
      ...manifest,
      declarative_net_request: {
        rule_resources: [
          { id: 'fx', enabled: true, path: 'rulesets/fx.json' },
          { id: 'fx-x', enabled: false, path: 'rulesets/fx-x.json' },
          { id: 'popups', enabled: true, path: 'rulesets/popups.json' },
        ],
      },
    }),
    'rulesets/fx.json': JSON.stringify(safe),
    'rulesets/fx-x.json': JSON.stringify(unsafe),
    'rulesets/popups.json': JSON.stringify(popupBuild.rules),
    // The rows' listed hosts, so the reconciler redirects them to the blocked page (P2-55) as the build does.
    ...(popups.length > 0 && { 'popup-destinations.json': JSON.stringify(popupBuild.destinations) }),
    'catalog.json': JSON.stringify({
      schema: 1,
      rulesets: {
        fx: { needsHostAccess: false, maxRules: 100, maxRegex: 0 },
        'fx-x': { needsHostAccess: true, maxRules: 100, maxRegex: 0 },
        popups: { needsHostAccess: false, maxRules: 100, maxRegex: 0 },
      },
      packs: {
        ads: {
          rulesets: ['fx', 'fx-x'],
          default: true,
          licence: 'cleared',
          registrations: [...compiled.registrations, ...registrations(fixtures)],
          generic: compiled.generic,
        },
        popups: { rulesets: ['popups'], default: true, licence: 'cleared', registrations: [] },
      },
      genericOff: compiled.genericOff,
    }),
    'cs/fx-probe.js': PROBE,
    // The compiler's `redirect=noopjs` target (cosmetic notes §5 resource names), here a marker script.
    'surrogates/noopjs.js': SURROGATE,
    'fx.html': BLANK_PAGE,
    'background.js': withBootCounter(await readFile(path.join(dir, 'background.js'), 'utf8')),
    ...Object.fromEntries(compiled.files),
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return { dir, remove: () => rm(root, { recursive: true, force: true }) };
}

/** Launches bundled Chromium on `profileDir` with the extension and the fixture server's flags. */
export async function launchCorpus(profileDir: string, extensionDir: string, serverArgs: readonly string[]): Promise<BrowserContext> {
  const onboarding = expectsOnboardingTab(profileDir, extensionDir);
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, ...serverArgs],
  });
  // D-46: the first-run tab of a fresh install is closed before any test sees the context.
  if (onboarding) await closeOnboardingTab(context);
  return context;
}

interface LastRun {
  readonly reason: string;
  readonly at: number;
}

async function lastRun(worker: Worker): Promise<{ pending: boolean; last: LastRun | undefined }> {
  return worker.evaluate(async () => {
    const got = await chrome.storage.session.get(['reconcile.pending', 'reconcile.last']);
    return {
      pending: got['reconcile.pending'] === true,
      last: got['reconcile.last'] as LastRun | undefined,
    };
  });
}

/** Waits until a reconcile whose reason matches finished after `since` and none is in flight. */
export async function reconciledSince(worker: Worker, since: number, reason: RegExp): Promise<void> {
  await expect
    .poll(async () => {
      const { pending, last } = await lastRun(worker);
      return !pending && last !== undefined && last.at >= since && reason.test(last.reason);
    }, POLL)
    .toBe(true);
}

/**
 * Stores `settings` in the vault from an extension page (the worker's private store, architecture notes §5.2)
 * and asks the worker to reconcile with `c/reconcile`, the way the panel's commands will.
 */
export async function applySettings(context: BrowserContext, worker: Worker, extensionId: string, settings: object, pagePath = 'fx.html'): Promise<void> {
  const page: Page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
    const since = Date.now();
    await page.evaluate(async (value) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('vault', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => {
          resolve(req.result);
        };
        req.onerror = () => {
          reject(req.error ?? new Error('open failed'));
        };
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, 'settings');
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error('write failed'));
        };
      });
      db.close();
      await chrome.runtime.sendMessage({ v: 1, type: 'c/reconcile', id: 'fx1', payload: {} });
    }, settings);
    await reconciledSince(worker, since, /^command$/);
  } finally {
    await page.close();
  }
}

interface DeveloperPrivate {
  updateExtensionConfiguration: (c: object) => Promise<void>;
  addHostPermission: (id: string, host: string) => Promise<void>;
}

/** Site access as the extensions menu sets it (S-10): all sites, on click, or this one site only. */
export async function setSiteAccess(context: BrowserContext, extensionId: string, access: 'all' | 'none' | 'site', site: string): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions');
    await page.evaluate(
      async ([id, mode, origin]) => {
        const dev = (globalThis as unknown as { chrome: { developerPrivate: DeveloperPrivate } }).chrome.developerPrivate;
        const hostAccess = mode === 'all' ? 'ON_ALL_SITES' : mode === 'none' ? 'ON_CLICK' : 'ON_SPECIFIC_SITES';
        await dev.updateExtensionConfiguration({ extensionId: id, hostAccess });
        if (mode === 'site') await dev.addHostPermission(id, origin);
      },
      [extensionId, access, `${new URL(site).origin}/*`] as const,
    );
  } finally {
    await page.close();
  }
}
