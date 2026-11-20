/**
 * P2-26: the static rule pool. Chrome rejects a whole `updateEnabledRulesets` call that would cross
 * what is left of the pool, so `computeDesired` skips the one pack that does not fit (by catalog
 * ceilings of the rulesets it would newly enable) instead of letting the default packs fail with it.
 */
import { describe, expect, test } from 'vitest';
import type { PackId, RulesetId } from '../../../../src/core/ids.js';
import { packRefusal, withPack } from '../../../../src/core/reconcile/packChoice.js';
import { computeDesired, DEFAULT_DESIRED_LIMITS } from '../../../../src/core/reconcile/computeDesired.js';
import { GRANTS, NOW, settings, toCatalog } from './fixtures.js';

const rid = (ids: readonly string[]): readonly RulesetId[] => ids as readonly RulesetId[];

/** `opt` precedes the default `base` in catalog order on purpose: defaults are filled first. */
const catalog = toCatalog({
  schema: 1,
  rulesets: {
    opt: { needsHostAccess: false, maxRules: 6_500, maxRegex: 60 },
    'opt-x': { needsHostAccess: true, maxRules: 100, maxRegex: 0 },
    base: { needsHostAccess: false, maxRules: 20_000, maxRegex: 400 },
    small: { needsHostAccess: false, maxRules: 500, maxRegex: 4 },
  },
  packs: {
    opt: { rulesets: ['opt', 'opt-x'], default: false, licence: 'cleared' },
    base: { rulesets: ['base'], default: true, licence: 'cleared' },
    small: { rulesets: ['small'], default: false, licence: 'cleared' },
  },
});

const allOn = settings({ packs: { opt: true, small: true } });
const run = (available: number, enabled: readonly string[], grants = GRANTS.allSites) =>
  computeDesired(allOn, grants, catalog, NOW, DEFAULT_DESIRED_LIMITS, { capacity: { available, enabled: rid(enabled) } });

describe('computeDesired: static rule pool (P2-26)', () => {
  test('without a capacity input nothing is skipped for rules (count unreadable: Chrome decides)', () => {
    const state = computeDesired(allOn, GRANTS.allSites, catalog, NOW);
    expect(state.skippedPacks).toEqual([]);
    expect(state.enabledRulesets).toEqual(['base', 'opt', 'opt-x', 'small']);
  });

  test('rulesets already enabled cost nothing: a pack that is on is never dropped by the check', () => {
    const state = run(0, ['base', 'opt', 'opt-x', 'small']);
    expect(state.skippedPacks).toEqual([]);
  });

  test('a pack whose newly enabled ceilings exceed what is left is skipped with needed / available', () => {
    const state = run(6_000, ['base']);
    expect(state.skippedPacks).toEqual([{ pack: 'opt', reason: 'rule-pool', needed: 6_600, available: 6_000 }]);
    expect(state.enabledRulesets).toEqual(['base', 'small']);
  });

  test('later packs see what earlier ones took; defaults go first whatever the catalog order', () => {
    const state = run(20_600, []);
    expect(state.enabledRulesets).toEqual(['base', 'small']);
    expect(state.skippedPacks).toEqual([{ pack: 'opt', reason: 'rule-pool', needed: 6_600, available: 600 }]);
  });

  test('-x rulesets count only where they are enabled (all-sites access)', () => {
    expect(run(6_500, ['base'], GRANTS.onClick).skippedPacks).toEqual([{ pack: 'small', reason: 'rule-pool', needed: 500, available: 0 }]);
    expect(run(6_500, ['base'], GRANTS.allSites).enabledRulesets).toEqual(['base', 'small']);
  });

  test('regex and slot skips carry needed / available too', () => {
    const state = computeDesired(allOn, GRANTS.allSites, catalog, NOW, { ...DEFAULT_DESIRED_LIMITS, staticRegex: 450 });
    expect(state.skippedPacks).toEqual([{ pack: 'opt', reason: 'regex-pool', needed: 60, available: 50 }]);
  });
});

describe('pack choice (P2-27, P2-31)', () => {
  const withGpc = toCatalog({
    schema: 1,
    rulesets: { 'gpc-x': { needsHostAccess: true, maxRules: 1, maxRegex: 0 }, cookies: { needsHostAccess: false, maxRules: 10, maxRegex: 0 } },
    packs: { gpc: { rulesets: ['gpc-x'], default: false, licence: 'cleared' }, cookies: { rulesets: ['cookies'], default: false, licence: 'cleared' } },
  });

  test('gpc and popups are not toggled by c/setPack; gpc follows settings.gpc, cookies follow cookieBanners', () => {
    expect(packRefusal(withGpc, 'gpc' as PackId)).toBe('not-toggleable');
    expect(packRefusal(withGpc, 'cookies' as PackId)).toBeNull();
    expect(computeDesired({ ...settings(), gpc: true }, GRANTS.allSites, withGpc, NOW).enabledRulesets).toEqual(['gpc-x']);
    expect(computeDesired({ ...settings({ packs: { gpc: true, cookies: true } }) }, GRANTS.allSites, withGpc, NOW).enabledRulesets).toEqual([]);
    expect(withPack(settings(), 'cookies' as PackId, true)).toMatchObject({ cookieBanners: 'hide', packs: {} });
  });
});
