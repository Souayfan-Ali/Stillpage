import { describe, expect, test } from 'vitest';
import { computeDesired } from '../../../../src/core/reconcile/computeDesired.js';
import type { DesiredState, Grants, ScriptRegistration } from '../../../../src/core/reconcile/types.js';
import { GRANTS, NOW, settings, testCatalog, type SettingsInput } from './fixtures.js';

function desired(input: SettingsInput = {}, grants: Grants = GRANTS.allSites): DesiredState {
  return computeDesired(settings(input), grants, testCatalog(), NOW);
}

function patterns(state: DesiredState): Record<string, Pick<ScriptRegistration, 'matches' | 'excludeMatches'>> {
  return Object.fromEntries(
    state.contentScripts.map((r) => [r.id, { matches: r.matches, excludeMatches: r.excludeMatches }]),
  );
}

describe('computeDesired: grants (host-access gate)', () => {
  test.each([
    ['all sites', GRANTS.allSites, ['easyprivacy', 'popups', 'ubo', 'ubo-x']],
    ['specific sites', GRANTS.specificSites, ['easyprivacy', 'popups', 'ubo']],
    ['on click', GRANTS.onClick, ['easyprivacy', 'popups', 'ubo']],
  ] as const)('%s → rulesets %j', (_name, grants, rulesets) => {
    expect(desired({}, grants).enabledRulesets).toEqual(rulesets);
  });

  test('reports whether host-access rules are installed', () => {
    expect(desired({}, GRANTS.allSites).hasAllSitesAccess).toBe(true);
    expect(desired({}, GRANTS.specificSites).hasAllSitesAccess).toBe(false);
  });

  test.each([
    ['default', {}],
    ['with Off and Light sites', { siteLevels: { 'example.com': 'off', 'a.news.org': 'light' } }],
  ] as const)('registrations never depend on grants (%s)', (_name, input) => {
    const all = desired(input, GRANTS.allSites).contentScripts;

    expect(desired(input, GRANTS.specificSites).contentScripts).toEqual(all);
    expect(desired(input, GRANTS.onClick).contentScripts).toEqual(all);
  });
});

describe('computeDesired: levels', () => {
  test('Standard default: every filter host matched, nothing excluded, no dynamic rules', () => {
    const state = desired();

    expect(patterns(state)).toEqual({
      'iso:ads:1': { matches: ['*://*.example.com/*', '*://*.news.org/*'], excludeMatches: [] },
      'main:ads:1': { matches: ['*://*.example.com/*'], excludeMatches: [] },
    });
    expect(state.dynamicRules).toEqual([]);
    expect(state.sessionRules).toEqual([]);
  });

  test('registrations carry the fixed registration flags', () => {
    expect(desired().contentScripts[0]).toMatchObject({
      world: 'ISOLATED',
      js: ['cs/ads/1.js'],
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: false, // P2-65: an ISOLATED shard is session-scoped
    });
  });

  test('Off site: allowAllRequests rule, and its filter host leaves every registration', () => {
    const state = desired({ siteLevels: { 'example.com': 'off' } });

    expect(state.dynamicRules).toEqual([
      {
        id: 1_000_000,
        priority: 15_000_000,
        action: { type: 'allowAllRequests' },
        condition: { requestDomains: ['example.com'], resourceTypes: ['main_frame'] },
      },
    ]);
    expect(patterns(state)).toEqual({
      'iso:ads:1': { matches: ['*://*.news.org/*'], excludeMatches: [] },
    });
  });

  test('Light subdomain: excluded from the registrations of its parent filter host only', () => {
    const state = desired({ siteLevels: { 'a.news.org': 'light' } });

    expect(patterns(state)).toEqual({
      'iso:ads:1': { matches: ['*://*.example.com/*', '*://*.news.org/*'], excludeMatches: ['*://*.a.news.org/*'] },
      'main:ads:1': { matches: ['*://*.example.com/*'], excludeMatches: [] },
    });
    expect(state.dynamicRules).toEqual([]);
  });

  test('Off under a Light parent: one exclusion root, one allowAllRequests host', () => {
    const state = desired({ siteLevels: { 'news.org': 'light', 'b.news.org': 'off' } });

    expect(patterns(state)['iso:ads:1']).toEqual({ matches: ['*://*.example.com/*'], excludeMatches: [] });
    expect(state.dynamicRules[0]?.condition.requestDomains).toEqual(['b.news.org']);
  });

  test('a Standard child under a Light parent stays capped (monotone levels)', () => {
    const state = desired({ siteLevels: { 'news.org': 'light', 'a.news.org': 'standard' } });
    expect(patterns(state)['iso:ads:1']?.matches).toEqual(['*://*.example.com/*']);
  });

  test('Light default: only subtrees raised to Standard or Thorough are matched', () => {
    const state = desired({ defaultLevel: 'light', siteLevels: { 'www.example.com': 'standard', 'news.org': 'thorough' } });

    expect(patterns(state)).toEqual({
      'iso:ads:1': { matches: ['*://*.news.org/*', '*://*.www.example.com/*'], excludeMatches: [] },
      'main:ads:1': { matches: ['*://*.www.example.com/*'], excludeMatches: [] },
    });
  });

  test('Light default with nothing raised: no registrations at all', () => {
    expect(desired({ defaultLevel: 'light' }).contentScripts).toEqual([]);
  });

  test('Thorough default registers the same shards as Standard', () => {
    expect(desired({ defaultLevel: 'thorough' }).contentScripts).toEqual(desired().contentScripts);
  });

  test('an active pause is Off; an expired one is ignored', () => {
    const paused = desired({ pauses: { 'news.org': NOW + 60_000 } });
    const expired = desired({ pauses: { 'news.org': NOW } });

    expect(paused.dynamicRules[0]?.condition.requestDomains).toEqual(['news.org']);
    expect(patterns(paused)['iso:ads:1']?.matches).toEqual(['*://*.example.com/*']);
    expect(expired).toEqual(desired());
  });

  test('coalesces Off hosts: subdomains of an Off host are not listed again', () => {
    const state = desired({ siteLevels: { 'a.com': 'off', 'b.a.com': 'off', 'c.com': 'off' } });
    expect(state.dynamicRules.map((r) => r.condition.requestDomains)).toEqual([['a.com', 'c.com']]);
  });

  test('splits many Off hosts into several rules inside the site-state realm', () => {
    const siteLevels = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`s${String(i)}.com`, 'off' as const]));
    const rules = desired({ siteLevels }).dynamicRules;

    expect(rules.map((r) => r.id)).toEqual([1_000_000, 1_000_001, 1_000_002]);
    expect(rules.flatMap((r) => r.condition.requestDomains ?? [])).toHaveLength(250);
  });
});

describe('computeDesired: packs', () => {
  test('an opt-in pack enabled by the user adds its rulesets and registrations', () => {
    const state = desired({ cookieBanners: 'hide' });

    expect(state.enabledRulesets).toEqual(['cookies', 'cookies-x', 'easyprivacy', 'popups', 'ubo', 'ubo-x']);
    expect(state.contentScripts.map((r) => r.id)).toEqual(['iso:ads:1', 'iso:cookies:3', 'main:ads:1']);
  });

  test('an opt-in pack without all-sites access gets only its safe ruleset', () => {
    expect(desired({ cookieBanners: 'hide' }, GRANTS.onClick).enabledRulesets).toContain('cookies');
    expect(desired({ cookieBanners: 'hide' }, GRANTS.onClick).enabledRulesets).not.toContain('cookies-x');
  });

  test('a default pack disabled by the user removes its rulesets and registrations', () => {
    const state = desired({ packs: { ads: false } });

    expect(state.enabledRulesets).toEqual(['easyprivacy', 'popups']);
    expect(state.contentScripts).toEqual([]);
  });

  test('a choice for a pack the catalog no longer has is ignored', () => {
    expect(desired({ packs: { gone: true } })).toEqual(desired());
  });

  test('returns equal states for equal inputs and does not modify them', () => {
    const input = settings({ siteLevels: { 'example.com': 'light' } });
    const catalog = testCatalog();
    const snapshot = JSON.stringify([input, catalog]);

    expect(computeDesired(input, GRANTS.allSites, catalog, NOW)).toEqual(computeDesired(input, GRANTS.allSites, catalog, NOW));
    expect(JSON.stringify([input, catalog])).toBe(snapshot);
  });
});

describe('computeDesired: prototype keys (review HIGH)', () => {
  test('a pack named like an Object.prototype member is not enabled by inheritance', () => {
    expect(desired({ siteLevels: { constructor: 'off' as const } }).dynamicRules[0]?.condition.requestDomains).toEqual([
      'constructor',
    ]);
    expect(desired().enabledRulesets).toEqual(desired({ packs: {} }).enabledRulesets);
  });
});
