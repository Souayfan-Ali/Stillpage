import { describe, expect, test } from 'vitest';
import { loadListsConfig } from '../../../../compiler/config/load.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import {
  assertBudgets, assertKnownKeys, ceilingProblems, countProblems, countSlot, CountsFileSchema, growthReport, serialiseCounts, slotsOf,
  withCarriedCounts, type SlotCount,
} from '../../../../compiler/postpass/budgets.js';
import { MAX_RULESET_FILE_BYTES } from '../../../../src/core/limits.js';

const CONFIG = new URL('../../../../lists/lists.config.json', import.meta.url).pathname;
const count = (rules: number, regex = 0, bytes = 10): SlotCount => ({ rules, regex, bytes });

describe('slots and ceilings (P1-25)', () => {
  test('the committed config declares 36 slots whose ceilings are the frozen budgets of filter-pipeline notes §8 (as rebalanced by D-21 and P2-32)', async () => {
    const slots = slotsOf(await loadListsConfig(CONFIG));
    expect(slots).toHaveLength(36);
    expect(ceilingProblems(slots)).toEqual([]);
    const pair = (id: string) => { const of = slots.filter((s) => s.ruleset === id); return [of.reduce((n, s) => n + s.budget.rules, 0), of.reduce((n, s) => n + s.budget.regex, 0)]; };
    expect(pair('ubo')).toEqual([7400, 235]);
    expect(pair('easylist')).toEqual([4250, 15]);
    expect(pair('easyprivacy')).toEqual([10250, 15]);
    expect(pair('badware')).toEqual([1520, 150]);
    expect(pair('urlhaus')).toEqual([50, 0]);
    expect(pair('popups')).toEqual([530, 5]);
    const sum = (key: 'rules' | 'regex') => slots.filter((s) => s.isDefault).reduce((n, s) => n + s.budget[key], 0);
    expect([sum('rules'), sum('regex')]).toEqual([24_000, 420]);
    // P2-32 (design review 2026-11-14): the non-default, non-regional rules redistributed inside 30,000 / 485.
    expect([pair('cookies'), pair('params'), pair('gpc')]).toEqual([[2200, 5], [1749, 40], [1, 0]]);
    const annoyances = ['annoy-overlays', 'annoy-social', 'annoy-widgets', 'annoy-newsletters', 'annoy-notifications'].map(pair);
    expect([annoyances.reduce((n, [r = 0]) => n + r, 0), annoyances.reduce((n, [, x = 0]) => n + x, 0)]).toEqual([2050, 20]);
    expect(slots.filter((s) => s.regional).map((s) => [s.id.endsWith('-x'), s.budget.rules, s.budget.regex])).toEqual(
      Array.from({ length: 6 }, () => [[false, 6400, 50], [true, 100, 10]]).flat());
    const defaults = slots.filter((s) => s.isDefault);
    expect(defaults.map((s) => s.id)).toEqual(['ubo', 'ubo-x', 'easylist', 'easylist-x', 'easyprivacy', 'easyprivacy-x', 'badware', 'badware-x', 'urlhaus', 'popups']);
    expect(slots.filter((s) => s.unsafe).every((s) => s.id.endsWith('-x'))).toBe(true);
  });

  test('ceilings that do not fit Chrome together are reported', async () => {
    const slots = slotsOf(await loadListsConfig(CONFIG));
    const fat = slots.map((s) => (s.id === 'ubo' ? { ...s, budget: { rules: 99_000, regex: 900 } } : s));
    expect(ceilingProblems(fat).join('\n')).toMatch(/default rule ceilings.*\n.*default regex ceilings[\s\S]*every slot enabled together/);
    expect(ceilingProblems(slots.slice(1))).toContain('35 ruleset slots declared, expected 36');
  });
});

describe('build counts against the budgets (P1-25)', () => {
  test('over a slot ceiling, over the file size, over the default total, an undeclared slot', async () => {
    const slots = slotsOf(await loadListsConfig(CONFIG));
    const ok = new Map(slots.map((s) => [s.id, count(Math.min(s.budget.rules, 1))]));
    expect(countProblems(slots, ok)).toEqual([]);
    expect(() => { assertBudgets(slots, ok); }).not.toThrow();
    const bad = new Map([...ok, ['ubo', count(6301, 196, MAX_RULESET_FILE_BYTES + 1)], ['nope', count(1)]]);
    expect(countProblems(slots, bad)).toEqual(['rules for undeclared slot "nope"', 'ubo rules: 6301 > 6300', 'ubo regex: 196 > 195',
      `ubo file bytes: ${String(MAX_RULESET_FILE_BYTES + 1)} > ${String(MAX_RULESET_FILE_BYTES)}`]);
    expect(() => { assertBudgets(slots, bad); }).toThrow(/over budget/);
    const many = new Map(slots.map((s) => [s.id, count(s.budget.rules, s.budget.regex)]));
    expect(countProblems(slots, many)).toEqual([]);
  });

  test('counts rules, regex and bytes; unknown keys fail', () => {
    const rules: DnrRule[] = [{ id: 1, action: { type: 'block' }, condition: { regexFilter: 'a' } }, { id: 2, action: { type: 'block' }, condition: {} }];
    expect(countSlot(rules, 'é')).toEqual({ rules: 2, regex: 1, bytes: 2 });
    expect(() => { assertKnownKeys('ubo', rules); }).not.toThrow();
    const odd = { id: 3, action: { type: 'block' }, condition: { x_src: 'l:1' } } as unknown as DnrRule;
    expect(() => { assertKnownKeys('ubo', [odd]); }).toThrow(/ubo rule 3/);
  });
});

describe('growth guard', () => {
  test('reports more than 10 % change either way, new slots and nothing without a previous build', () => {
    const prev = CountsFileSchema.parse({ schema: 1, slots: { ubo: { rules: 100, regex: 1 }, easylist: { rules: 100, regex: 0 }, badware: { rules: 100, regex: 0 } } });
    const now = new Map([['ubo', count(111)], ['easylist', count(89)], ['badware', count(110)], ['popups', count(5)]]);
    expect(growthReport(prev, now).map((g) => [g.slot, g.before, g.after])).toEqual([['ubo', 100, 111], ['easylist', 100, 89], ['popups', 0, 5]]);
    expect(growthReport(undefined, now)).toEqual([]);
  });

  test('the counts file round-trips sorted', () => {
    const text = serialiseCounts(new Map([['ubo', count(3, 1)], ['badware', count(2)]]));
    expect(Object.keys(CountsFileSchema.parse(JSON.parse(text)).slots)).toEqual(['badware', 'ubo']);
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('withCarriedCounts (D-125)', () => {
  const previous = CountsFileSchema.parse({ schema: 1, slots: { a: { rules: 5, regex: 1 }, zh: { rules: 70, regex: 2 }, 'zh-x': { rules: 3, regex: 0 } } });

  test('keeps the previous figures of carried slots and writes built ones as built', () => {
    const built = new Map([['a', count(6, 1)]]);
    const out = withCarriedCounts(built, previous, ['zh', 'zh-x']);
    expect(serialiseCounts(out)).toBe(serialiseCounts(new Map([['a', count(6, 1)], ['zh', count(70, 2)], ['zh-x', count(3, 0)]])));
  });

  test('without carried slots, or without previous counts, the output is the built counts', () => {
    const built = new Map([['a', count(6, 1)]]);
    expect(serialiseCounts(withCarriedCounts(built, previous, []))).toBe(serialiseCounts(built));
    expect(serialiseCounts(withCarriedCounts(built, undefined, ['zh']))).toBe(serialiseCounts(built));
  });

  test('a built slot is never overwritten by its previous figure', () => {
    const built = new Map([['zh', count(71, 2)]]);
    expect(withCarriedCounts(built, previous, ['zh']).get('zh')?.rules).toBe(71);
  });
});
