/**
 * P2-31: GPC = `gpc-x` (header) + the MAIN-world `gpc` registration (property), present only while
 * `settings.gpc` is on. Excluded on Off and paused sites only (a signal, not filtering: kept on Light,
 * design review 2026-11-14); the header needs `<all_urls>` like every `-x` ruleset.
 */
import { describe, expect, test } from 'vitest';
import { computeDesired } from '../../../../src/core/reconcile/computeDesired.js';
import { GPC_SCRIPT } from '../../../../src/core/reconcile/gpc.js';
import { GRANTS, NOW, settings, toCatalog } from './fixtures.js';

const catalog = toCatalog({
  schema: 1,
  rulesets: { ubo: { needsHostAccess: false, maxRules: 10, maxRegex: 0 }, 'gpc-x': { needsHostAccess: true, maxRules: 1, maxRegex: 0 } },
  packs: { ads: { rulesets: ['ubo'], default: true, licence: 'cleared' }, gpc: { rulesets: ['gpc-x'], default: false, licence: 'cleared' } },
});
const on = { ...settings({ siteLevels: { 'off.example': 'off', 'light.example': 'light' }, pauses: { 'p.example': NOW + 1 } }), gpc: true };

describe('GPC in the desired state', () => {
  test('off: neither the ruleset nor the registration', () => {
    const state = computeDesired(settings(), GRANTS.allSites, catalog, NOW);
    expect(state.enabledRulesets).toEqual(['ubo']);
    expect(state.contentScripts).toEqual([]);
  });

  test('on: header ruleset with all-sites access, property everywhere except Off and paused sites', () => {
    const state = computeDesired(on, GRANTS.allSites, catalog, NOW);
    expect(state.enabledRulesets).toEqual(['gpc-x', 'ubo']);
    expect(state.contentScripts).toEqual([{
      id: 'gpc', world: 'MAIN', js: [GPC_SCRIPT], matches: ['<all_urls>'], excludeMatches: ['*://*.off.example/*', '*://*.p.example/*'],
      runAt: 'document_start', allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: true,
    }]);
  });

  test('on without all-sites access: no header (host-access gate), the registration stays (Chrome skips it where access is missing)', () => {
    const state = computeDesired(on, GRANTS.onClick, catalog, NOW);
    expect(state.enabledRulesets).toEqual(['ubo']);
    expect(state.contentScripts.map((r) => r.id)).toEqual(['gpc']);
  });

  test('a build without the gpc pack registers nothing', () => {
    const noGpc = toCatalog({ schema: 1, rulesets: {}, packs: {} });
    expect(computeDesired(on, GRANTS.allSites, noGpc, NOW).contentScripts).toEqual([]);
  });
});
