import { describe, expect, test } from 'vitest';
import type { RulesetId } from '../../../src/core/ids.js';
import type { DnrRule } from '../../../src/core/reconcile/types.js';
import { createReconciler, LAST_KEY, PENDING_KEY, RETRY_ALARM } from '../../../src/background/reconciler.js';
import { SETTINGS_KEY } from '../../../src/background/settingsStore.js';
import { createFakeBrowser, type FakeBrowser } from '../platform/fakes/browser.js';
import type { FakeRuleset } from '../platform/fakes/dnr.js';
import { NOW, settings, testCatalog, toCatalog } from '../core/reconcile/fixtures.js';

const rid = (id: string): RulesetId => id as RulesetId;

/** The manifest of the test catalog: safe rulesets on, every `-x` off (P0-27 D-06). */
const MANIFEST: readonly FakeRuleset[] = ['ubo', 'ubo-x', 'easyprivacy', 'cookies', 'cookies-x', 'popups'].map((id) => ({
  id: rid(id),
  enabled: !id.endsWith('-x'),
  regexCount: 10,
}));

const WRITES = /\.(update|register|unregister)/;

function browser(): FakeBrowser {
  return createFakeBrowser({ rulesets: MANIFEST, catalog: testCatalog(), now: () => NOW });
}

const writes = (b: FakeBrowser, from = 0): string[] => b.calls().slice(from).filter((c) => WRITES.test(c));

async function state(b: FakeBrowser): Promise<Record<string, unknown>> {
  const { dnr, scripting } = b.ports;
  return {
    rulesets: await dnr.getEnabledRulesets(),
    scripts: (await scripting.getRegisteredContentScripts()).map((s) => s.id),
    dynamic: (await dnr.getDynamicRules()).map((r) => r.id),
  };
}

const redirectRule: DnrRule = {
  id: 1_200_001,
  priority: 2,
  action: { type: 'redirect', redirect: { regexSubstitution: 'chrome-extension://x/blocked.html#\\0' } },
  condition: { regexFilter: '^https://ads\\.test/', resourceTypes: ['main_frame'] },
};

describe('reconciler: install, re-run, update', () => {
  test('browser restart (P2-65): session-scoped registrations are gone; the startup run restores only them', async () => {
    // Arrange
    const b = browser();
    const reconciler = createReconciler(b.ports);
    await reconciler.request('install');
    b.simulateRestart();
    expect((await b.ports.scripting.getRegisteredContentScripts()).map((s) => s.id)).toEqual(['main:ads:1']);
    const mark = b.calls().length;

    // Act
    const outcome = await reconciler.request('startup');

    // Assert
    expect(outcome).toMatchObject({ status: 'applied', errors: [] });
    expect((await b.ports.scripting.getRegisteredContentScripts()).map((s) => [s.id, s.persistAcrossSessions])).toEqual([['iso:ads:1', false], ['main:ads:1', true]]);
    const writes = b.calls().slice(mark).filter((c) => c.startsWith('scripting.') && !c.startsWith('scripting.get'));
    expect(writes).toEqual(['scripting.registerContentScripts']);
  });

  test('install: rulesets and registrations applied; a second run writes nothing', async () => {
    // Arrange
    const b = browser();
    const reconciler = createReconciler(b.ports);

    // Act
    const first = await reconciler.request('install');
    const mark = b.calls().length;
    const second = await reconciler.request('startup');

    // Assert
    expect(first.status).toBe('applied');
    expect(await state(b)).toEqual({
      rulesets: ['easyprivacy', 'popups', 'ubo', 'ubo-x'],
      scripts: ['iso:ads:1', 'main:ads:1'],
      dynamic: [],
    });
    expect(second.status).toBe('unchanged');
    expect(writes(b, mark)).toEqual([]);
  });

  test('after simulateUpdate: scripts first (scriptlets before shards), then rulesets, then rules', async () => {
    // Arrange
    const b = browser();
    await b.ports.vault.set(SETTINGS_KEY, settings({ siteLevels: { 'off.test': 'off' } }));
    const reconciler = createReconciler(b.ports, { disabledRules: [{ rulesetId: rid('ubo'), ruleIds: [7] }] });
    await reconciler.request('install');
    b.simulateUpdate();
    const mark = b.calls().length;

    // Act
    await reconciler.request('update');

    // Assert: dynamic rules survived the update, so only the wiped parts are written, in order.
    expect(writes(b, mark)).toEqual([
      'scripting.registerContentScripts',
      'scripting.registerContentScripts',
      'dnr.updateEnabledRulesets',
      'dnr.updateStaticRules',
    ]);
    expect((await b.ports.scripting.getRegisteredContentScripts()).map((s) => s.id)).toEqual(['iso:ads:1', 'main:ads:1']);
    expect(await b.ports.dnr.getDisabledRuleIds(rid('ubo'))).toEqual([7]);
    expect(await state(b)).toMatchObject({ rulesets: ['easyprivacy', 'popups', 'ubo', 'ubo-x'], dynamic: [1_000_000] });
    const order = b.calls().slice(mark).filter((c) => c === 'scripting.registerContentScripts');
    expect(order).toHaveLength(2);
  });

  test('scriptlet registrations are registered before cosmetic shards', async () => {
    const b = browser();
    const registered: string[] = [];
    const original = b.ports.scripting;
    const ports = {
      ...b.ports,
      scripting: {
        ...b.ports.scripting,
        registerContentScripts: async (list: Parameters<typeof original.registerContentScripts>[0]) => {
          registered.push(...list.map((s) => s.id));
          await original.registerContentScripts(list);
        },
      },
    };
    await createReconciler(ports).request('install');
    expect(registered).toEqual(['main:ads:1', 'iso:ads:1']);
  });
});

describe('reconciler: host-access gate', () => {
  test('access removed: -x rulesets and redirect rules go first, before anything else', async () => {
    // Arrange
    const b = browser();
    const reconciler = createReconciler(b.ports);
    await reconciler.request('install');
    await b.ports.dnr.updateDynamicRules({ removeRuleIds: [], addRules: [redirectRule] });
    await b.ports.vault.set(SETTINGS_KEY, settings({ siteLevels: { 'off.test': 'off' } }));
    b.setSiteAccess({ origins: [] });
    const mark = b.calls().length;

    // Act
    await reconciler.request('permissions');

    // Assert
    const order = writes(b, mark);
    expect(order.slice(0, 2)).toEqual(['dnr.updateEnabledRulesets', 'dnr.updateDynamicRules']);
    expect(await state(b)).toEqual({
      rulesets: ['easyprivacy', 'popups', 'ubo'],
      scripts: ['iso:ads:1', 'main:ads:1'],
      dynamic: [1_000_000],
    });
  });

  test('access granted again: -x rulesets come back', async () => {
    const b = browser();
    b.setSiteAccess({ origins: ['https://example.com/*'] });
    const reconciler = createReconciler(b.ports);
    await reconciler.request('install');
    expect((await state(b))['rulesets']).toEqual(['easyprivacy', 'popups', 'ubo']);
    b.setSiteAccess({ origins: ['<all_urls>'] });
    await reconciler.request('permissions');
    expect((await state(b))['rulesets']).toEqual(['easyprivacy', 'popups', 'ubo', 'ubo-x']);
  });
});

describe('reconciler: failures', () => {
  test.each([
    'dnr.updateEnabledRulesets',
    'dnr.updateDynamicRules',
    'dnr.getDynamicRules',
  ])('a crash at %s is repaired by the next run', async (call) => {
    // Arrange
    const b = browser();
    await b.ports.vault.set(SETTINGS_KEY, settings({ siteLevels: { 'off.test': 'off' } }));
    const reconciler = createReconciler(b.ports);
    b.failNext(call);

    // Act
    const crashed = await reconciler.request('install');
    const repaired = await reconciler.request('retry');
    const after = await reconciler.request('check');

    // Assert
    expect(crashed.status).toBe('failed');
    expect(repaired.status).toBe('applied');
    expect(after.status).toBe('unchanged');
    expect(await state(b)).toEqual({
      rulesets: ['easyprivacy', 'popups', 'ubo', 'ubo-x'],
      scripts: ['iso:ads:1', 'main:ads:1'],
      dynamic: [1_000_000],
    });
  });

  test('an interrupted run leaves the pending flag, and resume runs again', async () => {
    const b = browser();
    b.failNext('dnr.updateEnabledRulesets');
    const reconciler = createReconciler(b.ports);
    await reconciler.request('install');
    expect(await b.ports.session.get(PENDING_KEY)).toBe(true);
    const resumed = await createReconciler(b.ports).resumeIfInterrupted();
    expect(resumed?.status).toBe('applied');
    expect(await b.ports.session.get(PENDING_KEY)).toBeUndefined();
    expect(await createReconciler(b.ports).resumeIfInterrupted()).toBeNull();
  });

  test('a missing or invalid catalog fails closed: nothing is written', async () => {
    const b = browser();
    b.failNext('catalog.read');
    const outcome = await createReconciler(b.ports).request('install');
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(writes(b)).toEqual([]);
    expect(b.logs().some((l) => l.startsWith('error: reconcile failed'))).toBe(true);
  });

  test('a transient rejection of a registration call is recovered in the same run', async () => {
    const b = browser();
    b.failNext('scripting.registerContentScripts');
    const outcome = await createReconciler(b.ports).request('install');
    expect(outcome).toMatchObject({ status: 'applied', errors: [] });
    expect((await state(b))['scripts']).toEqual(['iso:ads:1', 'main:ads:1']);
    // P2-65: only the core tier (MAIN shards here) persists; ISOLATED shards are session-scoped.
    expect((await b.ports.scripting.getRegisteredContentScripts()).map((s) => [s.id, s.persistAcrossSessions])).toEqual([['iso:ads:1', false], ['main:ads:1', true]]);
  });
});

describe('reconciler: serialisation', () => {
  test('overlapping requests never interleave and collapse into one extra run', async () => {
    // Arrange
    const b = browser();
    const reconciler = createReconciler(b.ports);

    // Act
    const results = await Promise.all([1, 2, 3, 4].map((n) => reconciler.request(`event ${String(n)}`)));

    // Assert
    expect(results.map((r) => r.status)).toEqual(['applied', 'unchanged', 'unchanged', 'unchanged']);
    expect(b.calls().filter((c) => c === 'catalog.read')).toHaveLength(2);
  });
});

describe('reconciler: pause alarm', () => {
  test('the earliest pause expiry is scheduled, and cleared when no pause is left', async () => {
    const b = browser();
    await b.ports.vault.set(SETTINGS_KEY, settings({ pauses: { 'a.test': NOW + 5_000, 'b.test': NOW + 1_000 } }));
    const reconciler = createReconciler(b.ports);
    await reconciler.request('install');
    expect(b.alarms()).toEqual({ 'pause-expiry': NOW + 1_000 });
    await b.ports.vault.set(SETTINGS_KEY, settings());
    await reconciler.request('alarm');
    expect(b.alarms()).toEqual({});
  });
});

describe('reconciler: one-shot retry after a failed lifecycle run (D-83)', () => {
  const RETRY_AT = NOW + 30_000;
  const setAts = (b: FakeBrowser): number => b.calls().filter((c) => c === 'alarms.setAt').length;

  test.each([
    ['startup', 'catalog.read'],
    ['startup', 'dnr.updateEnabledRulesets'],
    ['installed:install', 'dnr.updateEnabledRulesets'],
    ['installed:update', 'catalog.read'],
  ])('a failed %s run (fault at %s) schedules one retry 30 s later; the retry applies and clears it', async (reason, call) => {
    // Arrange
    const b = browser();
    const reconciler = createReconciler(b.ports);
    b.failNext(call);

    // Act
    const failed = await reconciler.request(reason);
    const scheduled = b.alarms();
    const retried = await reconciler.request(RETRY_ALARM);

    // Assert
    expect(failed.status).toBe('failed');
    expect(scheduled).toEqual({ [RETRY_ALARM]: RETRY_AT });
    expect(retried.status).toBe('applied');
    expect(b.alarms()).toEqual({});
    expect(setAts(b)).toBe(1);
  });

  test('a retry that fails again schedules nothing more and logs the error', async () => {
    // Arrange
    const b = browser();
    const reconciler = createReconciler(b.ports);
    b.failNext('catalog.read');
    await reconciler.request('startup');
    await b.ports.alarms.clear(RETRY_ALARM); // Chrome drops a one-shot alarm when it fires.
    b.failNext('catalog.read');

    // Act
    const retried = await reconciler.request(RETRY_ALARM);

    // Assert
    expect(retried.status).toBe('failed');
    expect(b.alarms()).toEqual({});
    expect(setAts(b)).toBe(1);
    expect(b.logs()).toContain(`error: reconcile failed (${RETRY_ALARM})`);
  });

  test.each(['startup', 'installed:install', 'installed:update'])('a successful %s run schedules nothing', async (reason) => {
    const b = browser();
    expect((await createReconciler(b.ports).request(reason)).status).toBe('applied');
    expect(b.alarms()).toEqual({});
    expect(setAts(b)).toBe(0);
  });

  test('other failed runs (a command, the retry itself) schedule no retry', async () => {
    const b = browser();
    const reconciler = createReconciler(b.ports);
    b.failNext('catalog.read');
    expect((await reconciler.request('command')).status).toBe('failed');
    expect(b.alarms()).toEqual({});
  });

  test('the pause alarm is unaffected: both alarms coexist, and the retry run keeps the pause alarm', async () => {
    // Arrange
    const b = browser();
    await b.ports.vault.set(SETTINGS_KEY, settings({ pauses: { 'a.test': NOW + 600_000 } }));
    const reconciler = createReconciler(b.ports);
    b.failNext('dnr.updateEnabledRulesets');

    // Act
    await reconciler.request('startup');
    const both = b.alarms();
    await reconciler.request(RETRY_ALARM);

    // Assert
    expect(both).toEqual({ 'pause-expiry': NOW + 600_000, [RETRY_ALARM]: RETRY_AT });
    expect(b.alarms()).toEqual({ 'pause-expiry': NOW + 600_000 });
  });
});

describe('reconciler: last outcome', () => {
  test('each run records reason, status and duration in storage.session', async () => {
    const b = browser();
    await createReconciler(b.ports).request('installed:install');
    expect(await b.ports.session.get(LAST_KEY)).toEqual({ reason: 'installed:install', status: 'applied', at: NOW, durationMs: 0, errors: [], scriptletsMs: 0 });
  });
});

describe('reconciler: batched registration with bisection', () => {
  test('a batch with one bad registration is split until only that one fails', async () => {
    // Arrange: a catalog with five cosmetic shards; Chrome rejects any batch containing shard 3.
    const hosts = (n: number): string[] => [`s${String(n)}.example`];
    const raw = {
      schema: 1,
      rulesets: { ubo: { needsHostAccess: false, maxRules: 1, maxRegex: 1 } },
      packs: {
        ads: {
          rulesets: ['ubo'],
          default: true,
          licence: 'cleared',
          registrations: [1, 2, 3, 4, 5].map((n) => ({ id: `iso:ads:${String(n)}`, world: 'ISOLATED', js: ['a.js'], hosts: hosts(n) })),
        },
      },
    };
    const b = createFakeBrowser({ rulesets: [{ id: rid('ubo'), enabled: true, regexCount: 1 }], catalog: toCatalog(raw), now: () => NOW });
    const calls: number[] = [];
    const original = b.ports.scripting;
    const ports = {
      ...b.ports,
      scripting: {
        ...original,
        registerContentScripts: async (list: Parameters<typeof original.registerContentScripts>[0]) => {
          calls.push(list.length);
          if (list.some((s) => s.id === 'iso:ads:3')) throw new Error('Invalid url pattern');
          await original.registerContentScripts(list);
        },
      },
    };

    // Act
    const outcome = await createReconciler(ports).request('install');

    // Assert
    expect(outcome).toMatchObject({ status: 'applied', errors: [], dropped: ['iso:ads:3: Invalid url pattern'] });
    expect(await b.ports.session.get(PENDING_KEY)).toBeUndefined();
    expect((await b.ports.scripting.getRegisteredContentScripts()).map((s) => s.id)).toEqual(['iso:ads:1', 'iso:ads:2', 'iso:ads:4', 'iso:ads:5']);
    expect(calls[0]).toBe(5);
    expect(calls.at(-1)).toBe(4);
    // The final call carries the desired flags, not the probes' (P2-65: ISOLATED shards are session-scoped).
    expect((await b.ports.scripting.getRegisteredContentScripts()).every((s) => !s.persistAcrossSessions)).toBe(true);
    expect(b.logs()).toContain('error: registration iso:ads:3 dropped');
  });
});

describe('reconciler: review fixes', () => {
  test('a probe whose cleanup fails stops the bisection and fails the run without dropping anything', async () => {
    const b = browser();
    const original = b.ports.scripting;
    let first = true;
    const ports = {
      ...b.ports,
      scripting: {
        ...original,
        registerContentScripts: async (list: Parameters<typeof original.registerContentScripts>[0]) => {
          if (first) {
            first = false;
            throw new Error('rejected');
          }
          await original.registerContentScripts(list);
        },
        unregisterContentScripts: () => Promise.reject(new Error('busy')),
      },
    };
    const outcome = await createReconciler(ports).request('install');
    expect(outcome.status).toBe('failed');
    expect(outcome.errors).toEqual(['probe cleanup failed: busy']);
    expect(outcome.dropped).toBeUndefined();
  });

  test('an unreadable vault fails the run before anything is written', async () => {
    const b = browser();
    const ports = { ...b.ports, vault: { get: () => Promise.reject(new Error('io')), set: () => Promise.resolve(), remove: () => Promise.resolve() } };
    const outcome = await createReconciler(ports).request('install');
    expect(outcome).toMatchObject({ status: 'failed', errors: ['vault unreadable'] });
    expect(writes(b)).toEqual([]);
  });

  test('a pause-alarm failure is reported with the run, the applied changes stay', async () => {
    const b = browser();
    b.failNext('alarms.clear');
    const outcome = await createReconciler(b.ports).request('install');
    expect(outcome.errors).toEqual(['pause alarm: injected fault: alarms.clear']);
    expect((await state(b))['scripts']).toEqual(['iso:ads:1', 'main:ads:1']);
  });

  test('a request during the follow-up run gets its own run, and resume does nothing while a run is in flight', async () => {
    const b = browser();
    const reconciler = createReconciler(b.ports);
    await b.ports.session.set(PENDING_KEY, true);
    const first = reconciler.request('a');
    expect(await reconciler.resumeIfInterrupted()).toBeNull();
    const second = reconciler.request('b');
    await second;
    const third = reconciler.request('c');
    expect((await Promise.all([first, second, third])).map((o) => o.status)).toEqual(['applied', 'unchanged', 'unchanged']);
    expect(b.calls().filter((c) => c === 'catalog.read')).toHaveLength(3);
  });
});

describe('site-level change (D-25): rules first, early answer', () => {
  async function installed(): Promise<{ b: FakeBrowser; reconciler: ReturnType<typeof createReconciler> }> {
    const b = browser();
    const reconciler = createReconciler(b.ports);
    await reconciler.request('install');
    return { b, reconciler };
  }

  test('Off on a filter host: the switch rule is written before the shard registration update', async () => {
    const { b, reconciler } = await installed();
    await b.ports.vault.set(SETTINGS_KEY, settings({ siteLevels: { 'example.com': 'off' } }));
    const mark = b.calls().length;
    expect((await reconciler.request('command')).status).toBe('applied');
    const w = writes(b, mark);
    expect(w[0]).toBe('dnr.updateDynamicRules');
    expect(w.indexOf('dnr.updateDynamicRules')).toBeLessThan(w.findIndex((c) => c.startsWith('scripting.')));
  });

  test('an install or update keeps the §5.1 order: registrations before rules', async () => {
    const b = browser();
    await b.ports.vault.set(SETTINGS_KEY, settings({ siteLevels: { 'example.com': 'off' } }));
    await createReconciler(b.ports).request('install');
    const w = writes(b);
    expect(w.findIndex((c) => c.startsWith('scripting.register'))).toBeLessThan(w.indexOf('dnr.updateDynamicRules'));
  });

  test('requestEarly answers "applying" once the rules are in, and the run still completes', async () => {
    const { b, reconciler } = await installed();
    await b.ports.vault.set(SETTINGS_KEY, settings({ siteLevels: { 'example.com': 'off' } }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const original = b.ports.scripting.updateContentScripts.bind(b.ports.scripting);
    b.ports.scripting.updateContentScripts = async (s) => { await gate; return original(s); };
    const early = await reconciler.requestEarly('command');
    expect(early.status).toBe('applying');
    release();
    const final = await reconciler.request('again');
    expect(final.status).toBe('unchanged');
    expect((await b.ports.scripting.getRegisteredContentScripts()).find((s) => s.id === 'iso:ads:1')?.matches).not.toContain('*://*.example.com/*');
  });

  test('requestEarly falls back to the final outcome when no rule changes', async () => {
    const { reconciler } = await installed();
    expect((await reconciler.requestEarly('command')).status).toBe('unchanged');
  });
});
