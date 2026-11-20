import { defineConfig } from '@playwright/test';
import { SHARED } from './playwright.config.js';

/**
 * Timing budgets (P2-47 stability, 2026-11-14): `@perf` tests (measure only) and `@budget` tests (correct
 * and measured), with `GLASSMERE_PERF=1` so `tests/e2e/helpers/perf.ts` asserts the budgets. Run by
 * `npm run test:perf` on a quiet machine; no retries, a timing miss is a result, not a flake.
 */
export default defineConfig({
  ...SHARED,
  grep: /@perf|@budget/,
  retries: 0,
});
