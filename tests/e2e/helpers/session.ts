/**
 * One journey session (P1-46): bundled Chromium on a throwaway profile with the corpus extension, the
 * fixture server's flags and the local-only CDP port (`RELOAD_ARGS`, for stopping or updating the
 * worker), the install reconcile awaited, and a probe page for the boot counter. Also Chrome's state
 * checked against `computeDesired` over the vault, the grants, the catalog and the worker's pop-up inputs
 * (moved here from the panel journeys), read from an extension page so it works whichever worker is running.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { readCatalog } from '../../../src/core/catalog/read.js';
import type { Catalog } from '../../../src/core/catalog/types.js';
import type { RulesetId } from '../../../src/core/ids.js';
import { readPopupInputs } from '../../../src/background/popupInputs.js';
import { computeDesired, DEFAULT_DESIRED_LIMITS } from '../../../src/core/reconcile/computeDesired.js';
import { diff, isEmptyPlan } from '../../../src/core/reconcile/diff.js';
import { createDefaultSettings } from '../../../src/core/state/defaults.js';
import { loadSettings } from '../../../src/core/state/load.js';
import { toDnrRule } from '../../../src/platform/dnr.js';
import { toRegistration } from '../../../src/platform/scripting.js';
import type { FixtureServer } from '../../fixtures/server/server.js';
import { openProbe, type ExtensionProbe } from './bootCounter.js';
import { extensionWorker, newProfile, RELOAD_ARGS } from './browser.js';
import { launchCorpus, reconciledSince } from './corpus.js';

export interface Session {
  readonly context: BrowserContext;
  readonly worker: Worker;
  readonly id: string;
  readonly profile: string;
  readonly probe: ExtensionProbe;
}

/** Launches on `profile` (a new one by default) and waits for the install reconcile. */
export async function startSession(server: FixtureServer, extensionDir: string, track: Set<BrowserContext>, profile?: string): Promise<Session> {
  const dir = profile ?? (await newProfile());
  const since = Date.now();
  const context = await launchCorpus(dir, extensionDir, [...server.chromiumArgs, ...RELOAD_ARGS]);
  track.add(context);
  const worker = await extensionWorker(context);
  await reconciledSince(worker, since, /^installed:/);
  const id = new URL(worker.url()).host;
  return { context, worker, id, profile: dir, probe: await openProbe(context, id) };
}

export async function catalogOf(extensionDir: string): Promise<Catalog> {
  const read = readCatalog(JSON.parse(await readFile(path.join(extensionDir, 'catalog.json'), 'utf8')));
  if (!read.ok) throw new Error(read.errors.join('\n'));
  return read.value;
}

/** A value of the worker's vault (IndexedDB `vault`, store `kv`), read from an extension page. */
export function vaultValue(page: Page, key: string): Promise<unknown> {
  return page.evaluate(async (name) => {
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
    const value = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get(name);
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error ?? new Error('read failed'));
      };
    });
    db.close();
    return value;
  }, key);
}

/** Chrome's actual state equals `computeDesired(vault settings, grants, catalog)`: an empty plan. */
export async function expectReconciled(page: Page, catalog: Catalog): Promise<void> {
  const stored = await vaultValue(page, 'settings');
  const settings = stored === undefined ? createDefaultSettings() : loadSettings(stored, Date.now()).settings;
  const chromeState = await page.evaluate(async () => {
    const d = chrome.declarativeNetRequest;
    const all = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    const origins = (await chrome.permissions.getAll()).origins ?? [];
    return {
      origins: all ? ['<all_urls>', ...origins.filter((o) => o !== '<all_urls>')] : origins.filter((o) => o !== '<all_urls>'),
      enabled: await d.getEnabledRulesets(),
      dynamic: await d.getDynamicRules(),
      session: await d.getSessionRules(),
      scripts: await chrome.scripting.getRegisteredContentScripts(),
    };
  });
  const popups = await readPopupInputs(
    {
      package: { readText: (file) => page.evaluate(async (f) => (await fetch(chrome.runtime.getURL(f))).text(), file) },
      log: {
        warn: () => undefined,
        error: (message) => {
          throw new Error(message);
        },
      },
    },
    new URL(page.url()).host,
  );
  const desired = computeDesired(settings, { origins: chromeState.origins }, catalog, Date.now(), DEFAULT_DESIRED_LIMITS, { popups });
  const plan = diff(desired, {
    enabledRulesets: chromeState.enabled as RulesetId[],
    dynamicRules: chromeState.dynamic.map(toDnrRule),
    sessionRules: chromeState.session.map(toDnrRule),
    contentScripts: chromeState.scripts.map(toRegistration),
  });
  expect(isEmptyPlan(plan), JSON.stringify(plan)).toBe(true);
}

/**
 * The open tab whose address starts with `prefix`, as the toolbar panel would name it. Asked from an
 * extension page or from the worker (the panel journeys, which open no probe page).
 */
export async function tabIdOf(from: Page | Worker, prefix: string): Promise<number> {
  const query = async (p: string): Promise<number | undefined> => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(p) === true)?.id;
  const id = 'goto' in from ? await from.evaluate(query, prefix) : await from.evaluate(query, prefix);
  if (id === undefined) throw new Error(`no tab at ${prefix}`);
  return id;
}

/** The toolbar panel for `tabId`, opened as a page of the session's context. */
export async function openPanel(s: Pick<Session, 'context' | 'id'>, tabId: number): Promise<Page> {
  const panel = await s.context.newPage();
  await panel.goto(`chrome-extension://${s.id}/popup.html?tabId=${String(tabId)}`);
  return panel;
}
