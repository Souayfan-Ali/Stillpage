/**
 * Stock priority band (ADR-011, D-10): every stock rule gets the converter's priority + 9, so the
 * stock band starts at 10 above the pop-up band (1–3). A shifted priority at or above 2,000,000
 * would reach the override bands, so the build fails instead.
 */
import { STOCK_PRIORITY_MAX, STOCK_PRIORITY_SHIFT } from '../../src/core/limits.js';
import type { ConvertedRule } from '../convert/convert.js';

const DEFAULT_PRIORITY = 1;

/** Thrown when a shifted stock priority leaves the stock band. */
export class PriorityOverflowError extends Error {
  constructor(readonly priority: number, readonly sources: readonly string[]) {
    super(`stock priority ${String(priority)} exceeds ${String(STOCK_PRIORITY_MAX)} (from: ${sources.join(' | ') || 'unknown'})`);
    this.name = 'PriorityOverflowError';
  }
}

/** The rules with priority = converter priority + 9. Pure; throws `PriorityOverflowError`. */
export function shiftStockPriorities(rules: readonly ConvertedRule[]): readonly ConvertedRule[] {
  return rules.map((r) => {
    const priority = (r.rule.priority ?? DEFAULT_PRIORITY) + STOCK_PRIORITY_SHIFT;
    if (priority > STOCK_PRIORITY_MAX) throw new PriorityOverflowError(priority, r.sources.map((s) => s.source.text));
    return { ...r, rule: { ...r.rule, priority } };
  });
}
