/**
 * P2-32 (design review 2026-11-14): the pattern budget is structured, not one "every pack on" line: default ≤
 * 40,000; optional non-regional together ≤ 48,000; each regional ≤ 6,000; default + every non-regional +
 * the largest regional ≤ 94,000 (also the runtime cap in `computeDesired`).
 */
import { describe, expect, test } from 'vitest';
import { fixedReserve, genericSizeProblems, patternBudgetProblems, scriptBytes } from '../../../../compiler/verify/patterns.js';
import * as L from '../../../../src/core/limits.js';
import { verifyContent } from '../../../../compiler/verify/content.js';

const packs = { defaults: new Set(['ads']), regional: new Set(['reg-de', 'reg-ja']) };

describe('pattern budgets', () => {
  test('the limits', () => {
    expect([L.DEFAULT_PATTERN_BUDGET, L.OPTIONAL_NON_REGIONAL_PATTERN_BUDGET, L.REGIONAL_PACK_PATTERN_BUDGET, L.ENABLED_PATTERN_BUDGET]).toEqual([40_000, 48_000, 6_000, 94_000]);
    expect(L.REGISTRATION_BUDGET).toBe(2_560);
    expect(L.REGIONAL_SHARD_COUNT).toBe(64);
  });

  test('measured build passes; each line fails on its own', () => {
    const ok = { ads: 36_236, cookies: 26_967, social: 18_268, 'reg-de': 2_107, 'reg-ja': 4_775 };
    expect(patternBudgetProblems(ok, packs)).toEqual([]);
    expect(patternBudgetProblems({ ...ok, ads: 40_001 }, packs)).toEqual(['40001 match patterns for the default packs > 40000']);
    expect(patternBudgetProblems({ ...ok, cookies: 30_000 }, packs)).toEqual(['48268 match patterns for the optional non-regional packs > 48000']);
    expect(patternBudgetProblems({ ...ok, 'reg-ja': 6_001 }, packs)).toEqual(['reg-ja: 6001 match patterns > 6000']);
  });

  test('the combined line: default + non-regional + largest regional ≤ 94,000', () => {
    const over = { ads: 40_000, cookies: 30_000, social: 18_000, 'reg-ja': 6_000 };
    expect(patternBudgetProblems(over, packs)).toEqual([]);
    expect(patternBudgetProblems({ ...over, social: 18_001 }, packs)).toContain('94001 match patterns for the default + every non-regional + the largest regional pack > 94000');
  });
});

describe('generic data per pack (P2-32, design review 2026-11-14)', () => {
  test('a pack generic.js over 650 kB raw fails; other files are not this line', () => {
    expect(L.GENERIC_PACK_MAX_BYTES).toBe(650_000);
    const files = new Map([['cosmetic/cookies/generic.js', 'x'.repeat(650_001)], ['cosmetic/ads/generic.js', 'x'], ['cosmetic/ads/0.js', 'x'.repeat(700_000)]]);
    expect(genericSizeProblems(files)).toEqual(['cosmetic/cookies/generic.js: 650001 B > 650000 (generic data per pack)']);
  });
});

describe('fixed registrations in the build gate (P2-32)', () => {
  test('the guard and GPC patterns count against the enabled-together line', () => {
    const at = { ads: 40_000, cookies: 30_000, social: 18_000, 'reg-ja': 6_000 };
    expect(patternBudgetProblems(at, packs, 0)).toEqual([]);
    expect(patternBudgetProblems(at, packs, 1)).toEqual(['94001 match patterns for the default + every non-regional + the largest regional pack > 94000']);
  });

  test('reserve: three guard registrations over the list Strict sites, plus GPC', () => {
    expect(fixedReserve(186)).toEqual({ patterns: 3 * 186 + 1, registrations: 4 });
  });
});

describe('registered script bytes and default registrations (P2-47, D-41)', () => {
  test('the limits', () => {
    expect([L.REGISTERED_SCRIPT_BYTES_BUDGET, L.DEFAULT_REGISTRATION_BUDGET, L.SHARD_TARGET_MEAN_BYTES, L.SHARD_TARGET_WORST_BYTES]).toEqual([10_000_000, 160, 32_000, 56_000]);
  });

  test('summed bytes count each registration’s files; unique counts each file once', () => {
    const files = new Map([['a.js', 'x'.repeat(100)], ['code.js', 'y'.repeat(1_000)]]);
    const regs = [{ id: 'iso:ads:0', world: 'ISOLATED' as const, js: ['a.js', 'code.js'], hosts: [] }, { id: 'iso:ads:1', world: 'ISOLATED' as const, js: ['code.js'], hosts: [] }];
    expect(scriptBytes(regs, (p) => Buffer.byteLength(files.get(p) ?? ''))).toEqual({ summed: 2_100, unique: 1_100 });
  });
});

describe('content gates for registered script bytes (P2-47, D-41)', () => {
  test('over 10 MB summed over the default registrations, or over 160 default registrations, fails', () => {
    const big = 'x'.repeat(60_000);
    const files = new Map([['cosmetic/procedural-engine.js', '//'], ['scriptlets/ads.main.js', big]]);
    const regs = Array.from({ length: 170 }, (_, i) => ({ id: `main:ads:${String(i)}`, world: 'MAIN' as const, js: ['scriptlets/ads.main.js'], hosts: [`h${String(i)}.com` as never] }));
    const problems = verifyContent({ files, registrations: new Map([['ads', regs]]), defaultPacks: new Set(['ads']) });
    expect(problems).toEqual(expect.arrayContaining(['10200000 registered script bytes summed over the default registrations > 10000000 (D-41)', '170 registrations for the default packs > 160 (D-23, D-41)']));
  });
});
