/**
 * P2-65 (D-79, S-23): Chrome re-processes every persistent registration's patterns on every register,
 * update or unregister call, on its UI thread, at a cost that grows with their square (36,735 patterns: about
 * 1.6 s per call). Only a capped core tier persists; the rest is session-scoped and restored on startup.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { PERSISTENT_PATTERN_CAP } from '../../../../src/core/limits.js';
import { persistentPatterns, withPersistence } from '../../../../src/core/reconcile/persistence.js';
import type { ScriptRegistration } from '../../../../src/core/reconcile/types.js';

const reg = (id: string, world: ScriptRegistration['world'], patterns: number, excluded = 0): ScriptRegistration => ({
  id, world, js: [`${id}.js`],
  matches: Array.from({ length: patterns }, (_, i) => `*://*.h${String(i)}.${id.replace(/\W/g, '')}.example/*`),
  excludeMatches: Array.from({ length: excluded }, (_, i) => `*://*.x${String(i)}.example/*`),
  runAt: 'document_start', allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: true,
});

const persisted = (list: readonly ScriptRegistration[]): string[] => list.filter((s) => s.persistAcrossSessions).map((s) => s.id);

describe('withPersistence (P2-65)', () => {
  test('the core tier persists in order: pop-up guard, GPC, notify gate, then MAIN shards of the default packs', () => {
    const list = [
      reg('iso:ads:0', 'ISOLATED', 10), reg('main:ads:1', 'MAIN', 10), reg('main:ads:0', 'MAIN', 10), reg('cosmetic-generic', 'ISOLATED', 1),
      reg('main:trackers:0', 'MAIN', 10), reg('notify-gate', 'ISOLATED', 1), reg('gpc', 'MAIN', 1), reg('popup-shim', 'MAIN', 5),
      reg('popup-sentinel', 'ISOLATED', 5), reg('popup-strict', 'ISOLATED', 5), reg('user-cosmetic', 'ISOLATED', 2),
    ];
    expect(persisted(withPersistence(list, 1_000))).toEqual(['main:ads:1', 'main:ads:0', 'main:trackers:0', 'notify-gate', 'gpc', 'popup-shim', 'popup-sentinel', 'popup-strict']);
  });

  test('a large optional pack cannot push the default packs\' MAIN shards out of the tier (review M3)', () => {
    const list = [reg('main:reg-de:0', 'MAIN', 90), reg('main:ads:0', 'MAIN', 50), reg('main:malware:0', 'MAIN', 10), reg('main:trackers:0', 'MAIN', 10)];
    expect(persisted(withPersistence(list, 100))).toEqual(['main:ads:0', 'main:malware:0', 'main:trackers:0']);
  });

  test('ISOLATED shards, the Thorough surveyor and user filters are session-scoped even under the cap', () => {
    const list = [reg('iso:ads:0', 'ISOLATED', 1), reg('iso:ads:1:f', 'ISOLATED', 1), reg('cosmetic-generic', 'ISOLATED', 1), reg('user-cosmetic', 'ISOLATED', 1)];
    expect(persisted(withPersistence(list, 1_000))).toEqual([]);
  });

  test('the tier stops at the cap; a later, smaller shard of the same rank still fits', () => {
    const list = [reg('popup-shim', 'MAIN', 40), reg('main:ads:0', 'MAIN', 50), reg('main:ads:1', 'MAIN', 50), reg('main:ads:2', 'MAIN', 5)];
    const out = withPersistence(list, 100);
    expect(persisted(out)).toEqual(['popup-shim', 'main:ads:0', 'main:ads:2']);
    expect(persistentPatterns(out)).toBe(95);
  });

  test('excludeMatches count against the cap', () => {
    const out = withPersistence([reg('popup-shim', 'MAIN', 1, 60), reg('main:ads:0', 'MAIN', 50)], 100);
    expect(persisted(out)).toEqual(['popup-shim']);
  });

  test('inputs are not changed; order and every other field are kept', () => {
    const list = Object.freeze([reg('main:ads:0', 'MAIN', 3), reg('iso:ads:0', 'ISOLATED', 3)]);
    const out = withPersistence(list, PERSISTENT_PATTERN_CAP);
    expect(list.map((s) => s.persistAcrossSessions)).toEqual([true, true]);
    expect(out.map((s) => s.id)).toEqual(['main:ads:0', 'iso:ads:0']);
    expect(out[1]).toEqual({ ...list[1], persistAcrossSessions: false });
  });

  test('property: never over the cap, deterministic, independent of input order', () => {
    const arb = fc.uniqueArray(
      fc.record({ id: fc.constantFrom('popup-shim', 'popup-sentinel', 'gpc', 'notify-gate', 'main:ads:0', 'main:ads:1', 'main:ads:2', 'main:trackers:0', 'iso:ads:0', 'cosmetic-generic'), n: fc.integer({ min: 0, max: 400 }) }),
      { selector: (r) => r.id },
    );
    fc.assert(fc.property(arb, fc.integer({ min: 0, max: 1_500 }), (items, cap) => {
      const list = items.map((r) => reg(r.id, r.id.startsWith('main:') || r.id === 'popup-shim' || r.id === 'gpc' ? 'MAIN' : 'ISOLATED', r.n));
      const out = withPersistence(list, cap);
      expect(persistentPatterns(out)).toBeLessThanOrEqual(cap);
      expect(persisted(withPersistence([...list].reverse(), cap)).sort()).toEqual(persisted(out).sort());
    }));
  });

  test('the shipped cap is 6,000 patterns (D-79e)', () => {
    expect(PERSISTENT_PATTERN_CAP).toBe(6_000);
  });
});
