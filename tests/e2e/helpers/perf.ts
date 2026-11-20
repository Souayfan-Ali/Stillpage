/**
 * Timing budgets in the E2E suite (P2-47 stability, 2026-11-14). The default `test:e2e` checks correctness
 * only, so its verdict does not depend on machine load; budgets are asserted by `npm run test:perf`, meant
 * for a quiet machine (P2-47's pass). Tags: `@perf` — a test that only measures, left out of the default
 * run; `@budget` — a correctness test that also measures: it runs in both, and its budgets assert only
 * when `GLASSMERE_PERF=1` (set by `test:perf`). Either way the figure is recorded as an annotation.
 */
import { expect, test } from '@playwright/test';

export const PERF_RUN = process.env['GLASSMERE_PERF'] === '1';

export function expectBudget(what: string, value: number, limit: number): void {
  test.info().annotations.push({ type: 'budget', description: `${what}: ${String(value)} (limit ${String(limit)}${PERF_RUN ? '' : ', asserted by test:perf'})` });
  if (PERF_RUN) expect(value, what).toBeLessThanOrEqual(limit);
}
