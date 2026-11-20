import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Catalog } from '../../../../src/core/catalog/types.js';
import { computeDesired, DEFAULT_DESIRED_LIMITS } from '../../../../src/core/reconcile/computeDesired.js';
import * as L from '../../../../src/core/limits.js';
import type { Level } from '../../../../src/core/state/types.js';
import { GRANTS, NOW, settings, testCatalog, toCatalog } from './fixtures.js';

/** A catalog of `packs` opt-in packs, each with one safe ruleset of `maxRegex` regex. */
function wideCatalog(packs: number, maxRegex: number): Catalog {
  const ids = Array.from({ length: packs }, (_, i) => `p${String(i)}`);
  return toCatalog({
    schema: 1,
    rulesets: Object.fromEntries(ids.map((id) => [id, { needsHostAccess: false, maxRules: 10, maxRegex }])),
    packs: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          rulesets: [id],
          default: true,
          licence: 'cleared',
          registrations: [{ id: `iso:${id}:0`, world: 'ISOLATED', js: [`cs/${id}/0.js`], hosts: [`${id}.com`, `www.${id}.org`] }],
        },
      ]),
    ),
  });
}

describe('computeDesired: limits', () => {
  test('the largest valid settings keep Off rules inside the site-state realm', () => {
    const many = (prefix: string): string[] => Array.from({ length: L.MAX_SITES_PER_LEVEL }, (_, i) => `${prefix}${String(i)}.com`);
    const siteLevels = Object.fromEntries(many('o').map((host) => [host, 'off' as const]));
    const pauses = Object.fromEntries(many('p').map((host) => [host, NOW + 1]));
    const rules = computeDesired(settings({ siteLevels, pauses }), GRANTS.allSites, testCatalog(), NOW).dynamicRules;

    expect(rules.flatMap((r) => r.condition.requestDomains ?? [])).toHaveLength(2 * L.MAX_SITES_PER_LEVEL);
    expect(rules.every((r) => L.dynamicRealmOf(r.id) === 'siteState')).toBe(true);
  });

  test('uses the Chrome limits and project budgets by default', () => {
    expect(DEFAULT_DESIRED_LIMITS).toEqual({
      enabledRulesets: L.MAX_ENABLED_RULESETS,
      staticRegex: L.STATIC_REGEX_POOL,
      registrations: L.REGISTRATION_BUDGET,
      patterns: L.ENABLED_PATTERN_BUDGET,
    });
  });

  test('skips a pack that would cross the enabled-ruleset limit', () => {
    const state = computeDesired(settings(), GRANTS.allSites, wideCatalog(51, 0), NOW);

    expect(state.enabledRulesets).toHaveLength(50);
    expect(state.skippedPacks).toEqual([{ pack: 'p50', reason: 'ruleset-slots', needed: 1, available: 0 }]);
    expect(state.contentScripts.map((r) => r.id)).not.toContain('iso:p50:0');
  });

  test('skips a pack that would cross the static regex pool, and keeps later packs that fit', () => {
    const catalog = wideCatalog(3, 400);
    const state = computeDesired(settings(), GRANTS.allSites, catalog, NOW);

    expect(state.enabledRulesets).toEqual(['p0', 'p1']);
    expect(state.skippedPacks).toEqual([{ pack: 'p2', reason: 'regex-pool', needed: 400, available: 200 }]);
  });

  test('skips packs over the registration and pattern budgets', () => {
    const catalog = wideCatalog(3, 0);
    const byRegistrations = computeDesired(settings(), GRANTS.allSites, catalog, NOW, {
      ...DEFAULT_DESIRED_LIMITS,
      registrations: 2,
    });
    const byPatterns = computeDesired(settings(), GRANTS.allSites, catalog, NOW, { ...DEFAULT_DESIRED_LIMITS, patterns: 5 });

    expect(byRegistrations.skippedPacks).toEqual([{ pack: 'p2', reason: 'registrations', needed: 1, available: 0 }]);
    expect(byPatterns.skippedPacks).toEqual([{ pack: 'p2', reason: 'patterns', needed: 2, available: 1 }]);
    expect(byPatterns.contentScripts.flatMap((r) => r.matches)).toHaveLength(4);
  });

  const level = fc.constantFrom<Level>('off', 'light', 'standard', 'thorough');
  const host = fc.constantFrom('example.com', 'a.example.com', 'news.org', 'b.news.org', 'shop.example', 'x.com');
  const input = fc.record({
    defaultLevel: fc.constantFrom('light', 'standard', 'thorough' as const),
    siteLevels: fc.dictionary(host, level),
    pauses: fc.dictionary(host, fc.integer({ min: NOW - 10, max: NOW + 10 })),
    packs: fc.dictionary(fc.constantFrom('ads', 'trackers', 'cookies', 'popups'), fc.boolean()),
    grants: fc.constantFrom(GRANTS.allSites, GRANTS.specificSites, GRANTS.onClick),
  });

  test('every output respects the limits and the host-access gate', () => {
    const catalog = testCatalog();
    fc.assert(
      fc.property(input, ({ grants, ...rest }) => {
        const state = computeDesired(settings(rest), grants, catalog, NOW);
        const regex = state.enabledRulesets.reduce((sum, id) => sum + (catalog.rulesets[id]?.maxRegex ?? 0), 0);
        const allSites = grants === GRANTS.allSites;

        expect(state.enabledRulesets.length).toBeLessThanOrEqual(L.MAX_ENABLED_RULESETS);
        expect(regex).toBeLessThanOrEqual(L.STATIC_REGEX_POOL);
        expect(state.contentScripts.length).toBeLessThanOrEqual(L.REGISTRATION_BUDGET);
        expect(state.dynamicRules.every((r) => L.dynamicRealmOf(r.id) === 'siteState')).toBe(true);
        expect(state.dynamicRules.every((r) => r.priority === L.OFF_PRIORITY)).toBe(true);
        expect(state.contentScripts.every((r) => r.matches.length > 0)).toBe(true);
        expect(new Set(state.dynamicRules.map((r) => r.id)).size).toBe(state.dynamicRules.length);
        expect(new Set(state.contentScripts.map((r) => r.id)).size).toBe(state.contentScripts.length);
        if (!allSites) {
          expect(state.enabledRulesets.some((id) => catalog.rulesets[id]?.needsHostAccess)).toBe(false);
          expect(state.dynamicRules.some((r) => ['redirect', 'modifyHeaders'].includes(r.action.type))).toBe(false);
        }
      }),
    );
  });
});
