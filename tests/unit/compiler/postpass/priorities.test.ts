import { readFileSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { POPUP_PRIORITY, STOCK_PRIORITY_MAX, STOCK_PRIORITY_SHIFT } from '../../../../src/core/limits.js';
import { convertRuleset, type ConvertedRule } from '../../../../compiler/convert/convert.js';
import { outranks } from '../../../../compiler/dnr/precedence.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { normaliseRuleset } from '../../../../compiler/normalise/normalise.js';
import { PriorityOverflowError, shiftStockPriorities } from '../../../../compiler/postpass/priorities.js';
import { classify } from '../../../../compiler/parse/classify.js';
import { arbRule } from './arbitraries.js';

interface Side { readonly ref?: string; readonly text: string }
interface Pair { readonly name: string; readonly a: Side; readonly b: Side; readonly winner: 'a' | 'b' }
const PAIRS = (JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../golden/compiler/priority-pairs.json'), 'utf8')) as { pairs: Pair[] }).pairs;

/** Compiles one filter line to its single stock rule (normalise → convert → shift). */
async function compileOne(text: string): Promise<DnrRule> {
  const entries = [{ ...classify(text), source: { list: 'l', line: 1, text }, trusted: true }];
  const { rules } = await convertRuleset(normaliseRuleset(entries, new Set()).inputs);
  // A `$redirect=` filter also yields its block (P1-22); the pair compares the redirect itself.
  const shifted = shiftStockPriorities(rules).filter((r) => !r.sources.some((s) => s.fixes.includes('redirect-implies-block')));
  expect(shifted, text).toHaveLength(1);
  const [first] = shifted;
  if (!first) throw new Error(`no rule for ${text}`);
  return first.rule;
}

const src = { text: 't', source: { list: 'l', line: 1, text: 't' }, fixes: [] };
const converted = (rule: DnrRule): ConvertedRule => ({ rule, sources: [src] });

describe('exception / $important table on real list samples (P1-21)', () => {
  test.each(PAIRS.map((p) => [p.name, p] as const))('%s', async (_name, p) => {
    const [a, b] = [await compileOne(p.a.text), await compileOne(p.b.text)];
    expect(outranks(a, b)).toBe(p.winner === 'a');
    expect(outranks(b, a)).toBe(p.winner === 'b');
  });
});

describe('stock priority shift', () => {
  test('stock priority = converter priority + 9; the band starts at 10', () => {
    const r = shiftStockPriorities([converted({ id: 1, action: { type: 'block' }, condition: {} }),
      converted({ id: 2, priority: 1_001_302, action: { type: 'block' }, condition: {} })]);
    expect(r.map((x) => x.rule.priority)).toEqual([1 + STOCK_PRIORITY_SHIFT, 1_001_302 + STOCK_PRIORITY_SHIFT]);
    expect(Math.min(...r.map((x) => x.rule.priority ?? 0))).toBe(10);
  });

  test('the build fails at 2,000,000 and names the source filter', () => {
    const ok = converted({ id: 1, priority: STOCK_PRIORITY_MAX - STOCK_PRIORITY_SHIFT, action: { type: 'block' }, condition: {} });
    expect(shiftStockPriorities([ok])[0]?.rule.priority).toBe(STOCK_PRIORITY_MAX);
    const over = converted({ id: 1, priority: STOCK_PRIORITY_MAX - STOCK_PRIORITY_SHIFT + 1, action: { type: 'block' }, condition: {} });
    expect(() => shiftStockPriorities([over])).toThrow(PriorityOverflowError);
    expect(() => shiftStockPriorities([over])).toThrow(/2000000 exceeds 1999999 \(from: t\)/);
  });

  test('property: the shift preserves every pairwise outcome', () => {
    fc.assert(fc.property(arbRule, arbRule, (x, y) => {
      const [sx, sy] = shiftStockPriorities([converted(x), converted(y)]).map((r) => r.rule) as [DnrRule, DnrRule];
      expect(outranks(sx, sy)).toBe(outranks(x, y));
    }));
  });

  test('a pop-up allow (3) loses to every stock block (≥ 10); a pop-up block (1) loses to every stock allow', async () => {
    const stockBlock = await compileOne('||ads.example^');
    const stockAllow = await compileOne('@@||ads.example^$document');
    const popupAllow: DnrRule = { id: 1, priority: POPUP_PRIORITY.allow, action: { type: 'allow' }, condition: { resourceTypes: ['main_frame'] } };
    const popupBlock: DnrRule = { id: 2, priority: POPUP_PRIORITY.block, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'] } };
    expect(stockBlock.priority).toBeGreaterThanOrEqual(10);
    expect(outranks(stockBlock, popupAllow)).toBe(true);
    expect(outranks(stockAllow, popupBlock)).toBe(true);
  });

  test('precedence on equal priority: allow > allowAllRequests > block > upgradeScheme > redirect', () => {
    const at = (type: DnrRule['action']['type']): DnrRule => ({ id: 1, priority: 5, action: { type }, condition: {} });
    const order = ['allow', 'allowAllRequests', 'block', 'upgradeScheme', 'redirect'] as const;
    order.forEach((t, i) => { if (i > 0) expect(outranks(at(order[i - 1] ?? t), at(t))).toBe(true); });
    expect(() => outranks(at('modifyHeaders'), at('block'))).toThrow(/no precedence/);
  });
});
