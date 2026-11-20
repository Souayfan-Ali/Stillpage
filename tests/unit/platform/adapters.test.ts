import { describe, expect, test, vi } from 'vitest';
import type { DnrApi, PermissionsApi, RuntimeApi, ScriptingApi, TabsApi } from '../../../src/platform/chromeApi.js';
import { createHash } from 'node:crypto';
import { createCatalogPort, createPackagePort, ownCatalogUrl } from '../../../src/platform/catalog.js';
import type { Hostname, PackId } from '../../../src/core/ids.js';
import { createDnrPort, toDnrRule } from '../../../src/platform/dnr.js';
import { createLogger } from '../../../src/platform/log.js';
import { createScriptingPort, toRegistration } from '../../../src/platform/scripting.js';
import { createTabsPort } from '../../../src/platform/tabs.js';
import { createAlarmsPort, createPermissionsPort, createSessionStorePort } from '../../../src/platform/simple.js';
import type { RulesetId } from '../../../src/core/ids.js';
import { computeDesired, DEFAULT_DESIRED_LIMITS } from '../../../src/core/reconcile/computeDesired.js';
import type { DnrRule } from '../../../src/core/reconcile/types.js';
import { GRANTS, NOW, settings, testCatalog } from '../core/reconcile/fixtures.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const runtime: RuntimeApi = { id: ID, getURL: (p) => `chrome-extension://${ID}/${p}` };

function permissions(all: boolean, origins: string[] | undefined): PermissionsApi {
  return { contains: () => Promise.resolve(all), getAll: () => Promise.resolve(origins === undefined ? {} : { origins }) };
}

describe('permissions adapter', () => {
  test.each([
    ['all sites', true, ['<all_urls>'], ['<all_urls>']],
    ['equivalent grant form counts as all sites', true, ['*://*/*', 'file:///*'], ['<all_urls>', '*://*/*', 'file:///*']],
    ['specific sites', false, ['http://127.0.0.1/*'], ['http://127.0.0.1/*']],
    ['on click', false, undefined, []],
    ['stale <all_urls> entry without contains()', false, ['<all_urls>'], []],
  ] as const)('%s', async (_name, all, origins, expected) => {
    const port = createPermissionsPort(permissions(all, origins ? [...origins] : undefined));
    expect(await port.getGrants()).toEqual({ origins: expected });
  });
});

describe('dnr adapter', () => {
  test('passes our shapes through as Chrome arguments and projects reads', async () => {
    // Arrange
    const api = {
      getEnabledRulesets: vi.fn(() => Promise.resolve(['ubo'])),
      getAvailableStaticRuleCount: vi.fn(() => Promise.resolve(8_650)),
      updateEnabledRulesets: vi.fn(() => Promise.resolve()),
      getDisabledRuleIds: vi.fn(() => Promise.resolve([3])),
      updateStaticRules: vi.fn(() => Promise.resolve()),
      getDynamicRules: vi.fn(() =>
        Promise.resolve([
          {
            id: 1,
            priority: 15_000_000,
            action: { type: 'allowAllRequests' },
            condition: { requestDomains: ['a.test'], resourceTypes: ['main_frame'], isUrlFilterCaseSensitive: false },
          },
        ]),
      ),
      updateDynamicRules: vi.fn(() => Promise.resolve()),
      getSessionRules: vi.fn(() => Promise.resolve([])),
      updateSessionRules: vi.fn(() => Promise.resolve()),
      getMatchedRules: vi.fn(() => Promise.resolve({ rulesMatchedInfo: [{ rule: { ruleId: 7, rulesetId: 'ubo' } }] })),
    } satisfies DnrApi;
    const port = createDnrPort(api);
    const ubo = 'ubo' as RulesetId;

    // Act
    await port.updateEnabledRulesets({ enable: [ubo], disable: [] });
    await port.updateStaticRules({ rulesetId: ubo, disableRuleIds: [1], enableRuleIds: [] });
    await port.updateDynamicRules({ removeRuleIds: [2], addRules: [] });
    await port.updateSessionRules({ removeRuleIds: [], addRules: [] });

    // Assert
    expect(await port.getEnabledRulesets()).toEqual(['ubo']);
    expect(await port.getAvailableStaticRuleCount()).toBe(8_650);
    expect(await port.getDisabledRuleIds(ubo)).toEqual([3]);
    expect(await port.getDynamicRules()).toEqual([
      { id: 1, priority: 15_000_000, action: { type: 'allowAllRequests' }, condition: { requestDomains: ['a.test'], resourceTypes: ['main_frame'] } },
    ]);
    expect(await port.getSessionRules()).toEqual([]);
    expect(await port.getMatchedRules(4)).toEqual([{ rulesetId: 'ubo', ruleId: 7 }]);
    expect(api.getMatchedRules).toHaveBeenCalledWith({ tabId: 4 });
    expect(api.updateEnabledRulesets).toHaveBeenCalledWith({ enableRulesetIds: ['ubo'], disableRulesetIds: [] });
    expect(api.updateStaticRules).toHaveBeenCalledWith({ rulesetId: 'ubo', disableRuleIds: [1], enableRuleIds: [] });
    expect(api.updateDynamicRules).toHaveBeenCalledWith({ removeRuleIds: [2], addRules: [] });
    expect(api.getDisabledRuleIds).toHaveBeenCalledWith({ rulesetId: 'ubo' });
  });

  test('keeps redirect targets and drops unknown fields', () => {
    const rule = toDnrRule({
      id: 5,
      priority: 2,
      action: { type: 'redirect', redirect: { regexSubstitution: 'x#\\0', transform: {} } },
      condition: { regexFilter: '^https://a/', tabIds: [1], domainType: 'thirdParty' },
    });
    // `tabIds` is kept since P2-55 ("Proceed once" session rules); other unknown fields are dropped.
    expect(rule).toEqual({ id: 5, priority: 2, action: { type: 'redirect', redirect: { regexSubstitution: 'x#\\0' } }, condition: { regexFilter: '^https://a/', tabIds: [1] } });
    expect(toDnrRule({})).toEqual({ action: {}, condition: {} });
  });

  test('keeps a lifted Proceed once URL filter and its case flag only when it is true (D-55a)', () => {
    const lifted = toDnrRule({ id: 1, priority: 5_000_001, action: { type: 'allow' }, condition: { urlFilter: '|https://a/|', isUrlFilterCaseSensitive: true, tabIds: [3] } });
    expect(lifted.condition).toEqual({ urlFilter: '|https://a/|', isUrlFilterCaseSensitive: true, tabIds: [3] });
    expect(toDnrRule({ id: 2, priority: 2, action: { type: 'allow' }, condition: { requestDomains: ['a'], isUrlFilterCaseSensitive: false } }).condition).toEqual({ requestDomains: ['a'] });
  });
});

describe('scripting adapter', () => {
  test('fills Chrome defaults on read and sends copies on write', async () => {
    const api = {
      getRegisteredContentScripts: vi.fn(() => Promise.resolve([{ id: 'a', js: ['x.js'], matches: ['<all_urls>'] }])),
      registerContentScripts: vi.fn(() => Promise.resolve()),
      updateContentScripts: vi.fn(() => Promise.resolve()),
      unregisterContentScripts: vi.fn(() => Promise.resolve()),
      insertCSS: vi.fn(() => Promise.resolve()),
    } satisfies ScriptingApi;
    const port = createScriptingPort(api);
    const [read] = await port.getRegisteredContentScripts();
    expect(read).toEqual({
      id: 'a', world: 'ISOLATED', js: ['x.js'], matches: ['<all_urls>'], excludeMatches: [],
      runAt: 'document_idle', allFrames: false, matchOriginAsFallback: false, persistAcrossSessions: false,
    });
    expect(toRegistration({ id: 'b' })).toMatchObject({ js: [], matches: [] });
    const script = toRegistration({ id: 'c', js: ['c.js'], matches: ['*://*.c.test/*'] });
    await port.registerContentScripts([script]);
    await port.updateContentScripts([script]);
    await port.unregisterContentScripts(['c']);
    expect(api.registerContentScripts).toHaveBeenCalledWith([script]);
    expect(api.unregisterContentScripts).toHaveBeenCalledWith({ ids: ['c'] });
    await port.insertCSS({ target: { tabId: 1, frameIds: [2] }, css: '.a{display:none!important}', origin: 'USER' });
    expect(api.insertCSS).toHaveBeenCalledWith({ target: { tabId: 1, frameIds: [2] }, css: '.a{display:none!important}', origin: 'USER' });
  });
});

describe('session store and alarms adapters', () => {
  test('session get/set/remove by key; alarms create and clear', async () => {
    const area = { get: vi.fn(() => Promise.resolve({ k: 1 })), set: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) };
    const session = createSessionStorePort(area);
    expect(await session.get('k')).toBe(1);
    await session.set('k', 2);
    await session.remove('k');
    expect(area.set).toHaveBeenCalledWith({ k: 2 });
    const alarmsApi = { create: vi.fn(() => Promise.resolve()), clear: vi.fn(() => Promise.resolve(true)) };
    const alarms = createAlarmsPort(alarmsApi);
    await alarms.setAt('p', 9);
    await alarms.clear('p');
    expect(alarmsApi.create).toHaveBeenCalledWith('p', { when: 9 });
  });
});

describe('catalog reader (own package only)', () => {
  const valid = { schema: 1, rulesets: {}, packs: {} };

  test('reads our own catalog.json, validates it and memoises per wake', async () => {
    const fetchJson = vi.fn(() => Promise.resolve(valid));
    const port = createCatalogPort(runtime, fetchJson);
    expect(await port.read()).toEqual({ ...valid, genericOff: null });
    await port.read();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledWith(`chrome-extension://${ID}/catalog.json`);
  });

  test('refuses a URL outside our package before any request', () => {
    const elsewhere: RuntimeApi = { id: ID, getURL: (p) => `https://evil.test/${p}` };
    expect(() => ownCatalogUrl(elsewhere)).toThrow(/not inside the extension package/);
    const otherId: RuntimeApi = { id: ID, getURL: (p) => `chrome-extension://${'b'.repeat(32)}/${p}` };
    expect(() => ownCatalogUrl(otherId)).toThrow();
  });

  test('an invalid or unreadable catalog rejects, and the next read tries again', async () => {
    const fetchJson = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce({ schema: 2 }).mockResolvedValue(valid);
    const port = createCatalogPort(runtime, fetchJson);
    await expect(port.read()).rejects.toThrow('404');
    await expect(port.read()).rejects.toThrow(/invalid catalog/);
    await expect(port.read()).resolves.toEqual({ ...valid, genericOff: null });
  });
});

describe('catalog reader: host lists in registrations.json (D-26)', () => {
  const regs = { schema: 1, packs: { ads: [{ id: 'iso:ads:0', world: 'ISOLATED', js: ['cosmetic/ads/0.js'], hosts: ['example.com'] }] } };
  const text = JSON.stringify(regs);
  const hex = (t: string): string => createHash('sha256').update(t).digest('hex');
  const digest = (t: string): Promise<string> => Promise.resolve(hex(t));
  const catalogWith = (sha256: string) => ({
    schema: 1, rulesets: {}, registrations: { path: 'registrations.json', sha256 },
    packs: { ads: { rulesets: [], default: true, licence: 'cleared' } },
  });

  test('reads the named file from our package, checks its SHA-256 and merges the registrations', async () => {
    const fetchText = vi.fn(() => Promise.resolve(text));
    const port = createCatalogPort(runtime, () => Promise.resolve(catalogWith(hex(text))), { fetchText, sha256: digest });
    const catalog = await port.read();
    expect(fetchText).toHaveBeenCalledWith(`chrome-extension://${ID}/registrations.json`);
    expect(catalog.packs['ads' as PackId]?.registrations.map((r) => r.hosts)).toEqual([['example.com']]);
  });

  test('readPacks reads catalog.json alone, memoised: never the host lists (D-65)', async () => {
    const fetchText = vi.fn(() => Promise.resolve(text));
    const fetchJson = vi.fn(() => Promise.resolve(catalogWith(hex(text))));
    const port = createCatalogPort(runtime, fetchJson, { fetchText, sha256: digest });
    const packs = await port.readPacks();
    expect(packs).toEqual({ ads: { rulesets: [], default: true, licence: 'cleared', generic: false, registrations: [] } });
    await port.readPacks();
    expect(fetchText).not.toHaveBeenCalled();
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  test('readPacks rejects an invalid catalog', async () => {
    const bad = createCatalogPort(runtime, () => Promise.resolve({ schema: 2 }));
    await expect(bad.readPacks()).rejects.toThrow(/invalid catalog/);
  });

  test('after a failed full read, readPacks reads catalog.json on its own (the panel shows the failed run)', async () => {
    const port = createCatalogPort(runtime, () => Promise.resolve(catalogWith('0'.repeat(64))), { fetchText: () => Promise.resolve(text), sha256: digest });
    await expect(port.read()).rejects.toThrow(/does not match/);
    expect((await port.readPacks())['ads' as PackId]?.default).toBe(true);
  });

  test('a digest mismatch rejects (fail closed)', async () => {
    const port = createCatalogPort(runtime, () => Promise.resolve(catalogWith('0'.repeat(64))), { fetchText: () => Promise.resolve(text), sha256: digest });
    await expect(port.read()).rejects.toThrow(/registrations.json does not match/);
  });
});

describe('package reader (P1-38)', () => {
  test('reads only shard data paths of our own package', async () => {
    const fetchText = vi.fn(() => Promise.resolve('data'));
    const port = createPackagePort(runtime, { fetchText, sha256: () => Promise.resolve('') });
    expect(await port.readText('cosmetic/ads/12.js')).toBe('data');
    expect(fetchText).toHaveBeenCalledWith(`chrome-extension://${ID}/cosmetic/ads/12.js`);
    await expect(port.readText('../catalog.json')).rejects.toThrow(/not a shard data path/);
    await expect(port.readText('scriptlets/ads.main.js')).rejects.toThrow();
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  test('P2-54: also the two packaged pop-up host lists, by exact name', async () => {
    const fetchText = vi.fn(() => Promise.resolve('[]'));
    const port = createPackagePort(runtime, { fetchText, sha256: () => Promise.resolve('') });
    expect(await port.readText('popup-destinations.json')).toBe('[]');
    expect(await port.readText('popup-strict-sites.json')).toBe('[]');
    await expect(port.readText('popup-destinations.json?x')).rejects.toThrow();
    await expect(port.readText('x/popup-strict-sites.json')).rejects.toThrow();
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
});

describe('logger', () => {
  test('keeps the last 50 entries and prints only when asked', () => {
    const log = createLogger(false);
    for (let i = 0; i < 60; i += 1) log.warn(`w${String(i)}`);
    log.error('boom', { a: 1 });
    expect(log.entries()).toHaveLength(50);
    expect(log.entries().at(-1)).toEqual({ level: 'error', message: 'boom', detail: { a: 1 } });
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createLogger(true).warn('shown');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe('read normalisers keep everything the worker writes (review MEDIUM 7)', () => {
  test('desired rules and registrations round-trip unchanged', () => {
    // Arrange: a desired state with Off rules, a pause and registrations in both worlds.
    const desired = computeDesired(
      settings({ siteLevels: { 'off.test': 'off', 'a.news.org': 'light' }, pauses: { 'p.test': NOW + 1 } }),
      GRANTS.allSites,
      testCatalog(),
      NOW,
      DEFAULT_DESIRED_LIMITS,
      {
        popups: {
          destinations: ['ad.test', 'lifted.test'] as Hostname[],
          lifted: { ubo: ['lifted.test'] as Hostname[] },
          strictSites: ['s.test'] as Hostname[],
          blockedPageUrl: 'chrome-extension://x/blocked.html',
          guardShipped: true,
          listStrict: true,
        },
      },
    );
    const redirect: DnrRule = {
      id: 1_200_000,
      priority: 2,
      action: { type: 'redirect', redirect: { regexSubstitution: 'chrome-extension://x/blocked.html#\\0' } },
      condition: { regexFilter: '^https://a\\.test/', resourceTypes: ['main_frame'] },
    };

    // Act / Assert
    expect([...desired.dynamicRules, redirect].map((r) => toDnrRule(structuredClone(r)))).toEqual([...desired.dynamicRules, redirect]);
    expect(desired.contentScripts.map((r) => toRegistration(structuredClone(r)))).toEqual(desired.contentScripts);
    expect(desired.dynamicRules.length).toBeGreaterThan(0);
    expect(desired.dynamicRules.some((r) => r.condition.initiatorDomains !== undefined)).toBe(true);
    expect(desired.contentScripts.some((r) => !r.allFrames)).toBe(true);
  });
});

describe('tabs adapter (tabs.get by id; no tabs permission, no tab events)', () => {
  const api = (tabs: Record<number, { url?: string; pendingUrl?: string }>, fail?: Error): TabsApi => ({
    get: (tabId) => {
      if (fail) return Promise.reject(fail);
      const tab = tabs[tabId];
      return tab === undefined ? Promise.reject(new Error(`No tab with id: ${String(tabId)}.`)) : Promise.resolve(tab);
    },
  });

  test('the address Chrome reports, null when it hides it, the pending address while loading', async () => {
    const port = createTabsPort(api({ 1: { url: 'https://a.example/' }, 2: {}, 3: { url: '', pendingUrl: 'https://b.example/' } }));
    expect(await port.get(1)).toEqual({ url: 'https://a.example/' });
    expect(await port.get(2)).toEqual({ url: null });
    expect(await port.get(3)).toEqual({ url: 'https://b.example/' });
  });

  test('an unknown tab is null; any other failure rejects', async () => {
    expect(await createTabsPort(api({})).get(9)).toBeNull();
    await expect(createTabsPort(api({}, new Error('boom'))).get(1)).rejects.toThrow('boom');
  });
});
