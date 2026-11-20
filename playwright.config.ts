import { defineConfig } from '@playwright/test';

const CI_RETRIES = 1;
/**
 * Per-test runner bound, not a budget (P2-47 stability): at load 35–45 launching Chromium and the real
 * build's install reconcile alone took > 15 s, and a picker test passed 30 s.
 */
const TEST_TIMEOUT_MS = 90_000;

// Extension tests share one persistent profile per test; run serially to keep them independent
// and cheap. Nothing here contacts the live web (testing notes §3).
export const SHARED = defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  timeout: TEST_TIMEOUT_MS,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
});

export default defineConfig({
  ...SHARED,
  retries: process.env['CI'] ? CI_RETRIES : 0,
  // Measure-only tests run in `npm run test:perf` (playwright.perf.config.ts), never here (P2-47 stability).
  grepInvert: /@perf/,
});
