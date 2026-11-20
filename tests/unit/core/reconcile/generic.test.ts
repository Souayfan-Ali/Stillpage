import { describe, expect, test } from 'vitest';
import { readCatalog } from '../../../../src/core/catalog/read.js';
import { mergeRegistrations } from '../../../../src/core/catalog/registrations.js';
import { computeDesired } from '../../../../src/core/reconcile/computeDesired.js';
import { GENERIC_REGISTRATION_ID, GENERIC_SURVEYOR } from '../../../../src/core/reconcile/generic.js';
import { GRANTS, NOW, settings, testCatalog, toCatalog } from './fixtures.js';

/** The test catalog with generic data on `ads` and `cookies`, and two `$generichide` hosts. */
function genericCatalog(off: readonly string[] | null = ['nogeneric.example', 'sub.thorough.example']) {
  const base = JSON.parse(JSON.stringify(testCatalog())) as { packs: Record<string, Record<string, unknown>>; genericOff: unknown };
  const packs = Object.fromEntries(Object.entries(base.packs).map(([id, p]) => [id, { ...p, generic: id === 'ads' || id === 'cookies' }]));
  const raw: Record<string, unknown> = { ...base, packs };
  delete raw['genericOff'];
  return toCatalog(off === null ? raw : { ...raw, genericOff: off });
}

const surveyor = (desired: ReturnType<typeof computeDesired>) => desired.contentScripts.find((s) => s.id === GENERIC_REGISTRATION_ID);

describe('cosmetic-generic registration (P2-25)', () => {
  test('none at the default Standard level: registration only where Thorough is used', () => {
    expect(surveyor(computeDesired(settings(), GRANTS.allSites, genericCatalog(), NOW))).toBeUndefined();
  });

  test('a site raised to Thorough: its root only, lowered subtrees and generichide hosts inside excluded', () => {
    const s = settings({ siteLevels: { 'thorough.example': 'thorough', 'low.thorough.example': 'light', 'elsewhere.example': 'light' } });
    expect(surveyor(computeDesired(s, GRANTS.allSites, genericCatalog(), NOW))).toEqual({
      id: GENERIC_REGISTRATION_ID,
      world: 'ISOLATED',
      js: ['cosmetic/ads/generic.js', GENERIC_SURVEYOR],
      matches: ['*://*.thorough.example/*'],
      excludeMatches: ['*://*.low.thorough.example/*', '*://*.sub.thorough.example/*'],
      runAt: 'document_idle',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: false, // P2-65: the Thorough surveyor is session-scoped
    });
  });

  test('Thorough by default: <all_urls> minus every Standard-or-below root, pause and generichide host', () => {
    const s = settings({ defaultLevel: 'thorough', siteLevels: { 'std.example': 'standard' }, pauses: { 'paused.example': NOW + 60_000 }, cookieBanners: 'hide' });
    const reg = surveyor(computeDesired(s, GRANTS.onClick, genericCatalog(), NOW));
    expect(reg?.matches).toEqual(['<all_urls>']);
    expect(reg?.excludeMatches).toEqual(['*://*.nogeneric.example/*', '*://*.paused.example/*', '*://*.std.example/*', '*://*.sub.thorough.example/*']);
    expect(reg?.js).toEqual(['cosmetic/ads/generic.js', 'cosmetic/cookies/generic.js', GENERIC_SURVEYOR]);
  });

  test('fail closed: no $generichide list, no pack with generic data, or every such pack off', () => {
    const s = settings({ defaultLevel: 'thorough' });
    expect(surveyor(computeDesired(s, GRANTS.allSites, genericCatalog(null), NOW))).toBeUndefined();
    expect(surveyor(computeDesired(s, GRANTS.allSites, testCatalog(), NOW))).toBeUndefined();
    expect(surveyor(computeDesired(settings({ defaultLevel: 'thorough', packs: { ads: false } }), GRANTS.allSites, genericCatalog(), NOW))).toBeUndefined();
  });

  test('reserved before the packs: a tight registration limit skips a pack, not the surveyor', () => {
    const s = settings({ defaultLevel: 'thorough', cookieBanners: 'hide' });
    const loose = computeDesired(s, GRANTS.allSites, genericCatalog(), NOW);
    const shards = loose.contentScripts.filter((r) => r.id !== GENERIC_REGISTRATION_ID).length;
    const tight = computeDesired(s, GRANTS.allSites, genericCatalog(), NOW, { enabledRulesets: 50, staticRegex: 1000, registrations: shards, patterns: 100_000 });
    expect(tight.skippedPacks).toMatchObject([{ pack: 'cookies', reason: 'registrations' }]);
    expect(surveyor(tight)?.js).toEqual(['cosmetic/ads/generic.js', GENERIC_SURVEYOR]);
  });
});

describe('scope edge cases (review findings)', () => {
  test('a host set to Thorough under a Standard or paused parent is not Thorough (levels are monotone), so excluding the parent is exact', () => {
    const s = settings({ defaultLevel: 'thorough', siteLevels: { 'a.example': 'standard', 'b.a.example': 'thorough' }, pauses: { 'p.example': NOW + 60_000 } });
    const reg = surveyor(computeDesired(s, GRANTS.allSites, genericCatalog(), NOW));
    expect(reg?.excludeMatches).toEqual(expect.arrayContaining(['*://*.a.example/*', '*://*.p.example/*']));
    expect(reg?.excludeMatches).not.toContain('*://*.b.a.example/*');
    const nested = settings({ siteLevels: { 'a.example': 'standard', 'b.a.example': 'thorough' } });
    expect(surveyor(computeDesired(nested, GRANTS.allSites, genericCatalog(), NOW))).toBeUndefined();
  });

  test('nothing is reserved when no pack with generic data is on', () => {
    const s = settings({ defaultLevel: 'thorough', packs: { ads: false } });
    const loose = computeDesired(s, GRANTS.allSites, genericCatalog(), NOW);
    const shards = loose.contentScripts.length;
    const exact = computeDesired(s, GRANTS.allSites, genericCatalog(), NOW, { enabledRulesets: 50, staticRegex: 1000, registrations: shards, patterns: 100_000 });
    expect(exact.skippedPacks).toEqual([]);
  });
});

describe('genericOff in the catalog (P2-25)', () => {
  test('carried from registrations.json; must be canonical, sorted and unique', () => {
    const merged = mergeRegistrations({ schema: 1, rulesets: {}, packs: {} }, { schema: 1, packs: {}, genericOff: ['a.example', 'b.example'] });
    expect(readCatalog(merged)).toMatchObject({ ok: true, value: { genericOff: ['a.example', 'b.example'] } });
    for (const bad of [['b.example', 'a.example'], ['a.example', 'a.example'], ['Not A Host']]) {
      expect(readCatalog({ schema: 1, rulesets: {}, packs: {}, genericOff: bad }).ok).toBe(false);
    }
    expect(readCatalog({ schema: 1, rulesets: {}, packs: {} })).toMatchObject({ ok: true, value: { genericOff: null } });
  });
});
