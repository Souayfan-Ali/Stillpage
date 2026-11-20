import { describe, expect, test } from 'vitest';
import { computeDesired } from '../../../../src/core/reconcile/computeDesired.js';
import { NOTIFY_GATE_SCRIPT } from '../../../../src/core/reconcile/notifyGate.js';
import { GRANTS, NOW, settings, testCatalog, toCatalog } from './fixtures.js';

/** The test catalog plus the Notification prompts pack (opt-in, one safe ruleset). */
function catalog() {
  const base = JSON.parse(JSON.stringify(testCatalog())) as { rulesets: Record<string, unknown>; packs: Record<string, unknown>; genericOff?: unknown };
  delete base.genericOff;
  return toCatalog({
    ...base,
    rulesets: { ...base.rulesets, 'annoy-notifications': { needsHostAccess: false, maxRules: 100, maxRegex: 0 } },
    packs: { ...base.packs, 'annoy-notifications': { rulesets: ['annoy-notifications'], default: false, licence: 'cleared' } },
  });
}

const gate = (d: ReturnType<typeof computeDesired>) => d.contentScripts.find((s) => s.id === 'notify-gate');

describe('notify-gate registration (P2-63)', () => {
  test('absent while the Notification prompts pack is off (the default, Q-24)', () => {
    expect(gate(computeDesired(settings(), GRANTS.allSites, catalog(), NOW))).toBeUndefined();
  });

  test('present while the pack is on: MAIN, document_start, every frame, minus Off, Light and paused subtrees', () => {
    const s = settings({ packs: { 'annoy-notifications': true }, siteLevels: { 'off.example': 'off', 'light.example': 'light', 'std.example': 'standard' }, pauses: { 'p.example': NOW + 60_000 } });
    expect(gate(computeDesired(s, GRANTS.onClick, catalog(), NOW))).toEqual({
      id: 'notify-gate',
      world: 'MAIN',
      js: [NOTIFY_GATE_SCRIPT],
      matches: ['<all_urls>'],
      excludeMatches: ['*://*.light.example/*', '*://*.off.example/*', '*://*.p.example/*'],
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
    });
  });

  test('absent when the pack does not fit (skipped), or the build has no such pack', () => {
    const on = settings({ packs: { 'annoy-notifications': true } });
    const tight = computeDesired(on, GRANTS.allSites, catalog(), NOW, { enabledRulesets: 3, staticRegex: 1000, registrations: 100, patterns: 100_000 });
    expect(tight.skippedPacks.map((p) => p.pack)).toContain('annoy-notifications');
    expect(gate(tight)).toBeUndefined();
    expect(gate(computeDesired(on, GRANTS.allSites, testCatalog(), NOW))).toBeUndefined();
  });
});
