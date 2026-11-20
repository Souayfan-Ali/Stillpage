import { defineConfig } from 'vitest/config';

/**
 * Timing budgets (P2-47 stability, 2026-11-14): measured on a quiet machine by `npm run test:perf`, never
 * in the default `npm test`, whose results must not depend on machine load. One file at a time, so the
 * measurements do not compete with each other.
 */
export default defineConfig({
  test: {
    include: ['tests/perf/unit/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
