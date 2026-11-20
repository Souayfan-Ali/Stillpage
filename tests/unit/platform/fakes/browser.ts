/**
 * A fake browser for worker tests (P1-08): every port in memory, Chrome's limits enforced,
 * `simulateUpdate()` with the reset semantics measured in S-07/S-17, fault injection for crash
 * tests (P1-11) and a call log for step-order assertions.
 */
import type { Catalog } from '../../../../src/core/catalog/types.js';
import { CATALOG_SCHEMA } from '../../../../src/core/catalog/types.js';
import type { Grants } from '../../../../src/core/reconcile/types.js';
import type { CssInjection, Ports } from '../../../../src/platform/ports.js';
import { CHROME_DNR_LIMITS, createFakeDnr, type FakeDnrLimits, type FakeRuleset } from './dnr.js';
import { createFakeScripting } from './scripting.js';
import { copy } from './ruleChecks.js';

export interface FakeBrowserOptions {
  readonly rulesets: readonly FakeRuleset[];
  readonly limits?: Partial<FakeDnrLimits>;
  readonly catalog?: Catalog;
  /** Packaged files by path, for `ports.package` (P1-38). */
  readonly packageFiles?: Readonly<Record<string, string>>;
  readonly now?: () => number;
}

export interface FakeBrowser {
  readonly ports: Ports;
  readonly simulateUpdate: () => void;
  /** Browser restart: non-persistent registrations and session rules are gone (P2-65). */
  readonly simulateRestart: () => void;
  readonly setSiteAccess: (grants: Grants) => void;
  /** Opens or changes tab `id`; `url: null` is a tab whose address Chrome withholds (no host access). */
  readonly setTab: (id: number, url: string | null) => void;
  /** The next call of `port.method` throws (a crash between steps). */
  readonly failNext: (call: string) => void;
  /** What Chrome's matcher reports for a tab (P2-11); `null` = no `activeTab` grant. */
  readonly setMatchedRules: (tabId: number, matches: readonly { rulesetId: string; ruleId: number }[] | null) => void;
  /** Every port call so far, as `port.method`, in order. */
  readonly calls: () => readonly string[];
  /** Every `scripting.insertCSS` call so far. */
  readonly insertedCss: () => readonly CssInjection[];
  readonly alarms: () => Readonly<Record<string, number>>;
  /** Messages logged by the worker, as `level: message`. */
  readonly logs: () => readonly string[];
}

const EMPTY_CATALOG: Catalog = { schema: CATALOG_SCHEMA, rulesets: {}, packs: {}, genericOff: null };

function keyValueStore(): { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void>; remove: (k: string) => Promise<void> } {
  let items: Readonly<Record<string, unknown>> = {};
  return {
    get: (key) => Promise.resolve(Object.hasOwn(items, key) ? copy(items[key]) : undefined),
    set: (key, value) => {
      items = { ...items, [key]: copy(value) };
      return Promise.resolve();
    },
    remove: (key) => {
      items = Object.fromEntries(Object.entries(items).filter(([k]) => k !== key));
      return Promise.resolve();
    },
  };
}

type AnyFn = (...args: never[]) => Promise<unknown>;

/** Wraps every method of `port` with the call log and fault injection. */
function instrument<T extends object>(name: string, port: T, log: string[], faults: Set<string>): T {
  const entries = Object.entries(port as Record<string, AnyFn>).map(([method, fn]) => {
    const call = `${name}.${method}`;
    const wrapped = async (...args: never[]): Promise<unknown> => {
      log.push(call);
      if (faults.delete(call)) throw new Error(`injected fault: ${call}`);
      return fn(...args);
    };
    return [method, wrapped] as const;
  });
  return Object.fromEntries(entries) as T;
}

export function createFakeBrowser(options: FakeBrowserOptions): FakeBrowser {
  const log: string[] = [];
  const logs: string[] = [];
  const faults = new Set<string>();
  const dnr = createFakeDnr(options.rulesets, { ...CHROME_DNR_LIMITS, ...options.limits });
  const scripting = createFakeScripting();
  let grants: Grants = { origins: ['<all_urls>'] };
  let alarms: Readonly<Record<string, number>> = {};
  let tabs: ReadonlyMap<number, string | null> = new Map();
  const session = keyValueStore();
  const vault = keyValueStore();
  const catalog = options.catalog ?? EMPTY_CATALOG;

  const ports: Ports = {
    dnr: instrument('dnr', dnr.port, log, faults),
    scripting: instrument('scripting', scripting.port, log, faults),
    session: instrument('session', session, log, faults),
    vault: instrument('vault', { get: vault.get, set: vault.set, remove: vault.remove }, log, faults),
    permissions: instrument('permissions', { getGrants: () => Promise.resolve(copy(grants)) }, log, faults),
    alarms: instrument(
      'alarms',
      {
        setAt: (name: string, when: number) => {
          alarms = { ...alarms, [name]: when };
          return Promise.resolve();
        },
        clear: (name: string) => {
          alarms = Object.fromEntries(Object.entries(alarms).filter(([k]) => k !== name));
          return Promise.resolve();
        },
      },
      log,
      faults,
    ),
    catalog: instrument('catalog', { read: () => Promise.resolve(catalog), readPacks: () => Promise.resolve(catalog.packs) }, log, faults),
    package: instrument('package', {
      readText: (path: string) => {
        const text = options.packageFiles?.[path];
        return text === undefined ? Promise.reject(new Error(`no packaged ${path}`)) : Promise.resolve(text);
      },
    }, log, faults),
    tabs: instrument('tabs', { get: (id: number) => Promise.resolve(tabs.has(id) ? { url: tabs.get(id) ?? null } : null) }, log, faults),
    log: {
      warn: (message) => logs.push(`warn: ${message}`),
      error: (message) => logs.push(`error: ${message}`),
    },
    now: options.now ?? (() => 0),
  };

  return {
    ports,
    simulateUpdate: () => {
      scripting.clear();
      dnr.resetToManifest();
    },
    simulateRestart: () => {
      scripting.endSession();
      dnr.endSession();
    },
    setSiteAccess: (next) => {
      grants = copy(next);
    },
    setTab: (id, url) => {
      tabs = new Map([...tabs, [id, url]]);
    },
    failNext: (call) => faults.add(call),
    setMatchedRules: dnr.setMatchedRules,
    calls: () => [...log],
    insertedCss: () => scripting.inserted(),
    alarms: () => ({ ...alarms }),
    logs: () => [...logs],
  };
}
