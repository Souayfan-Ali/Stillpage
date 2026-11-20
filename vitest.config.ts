import { defineConfig } from 'vitest/config';

/** testing notes §2: ≥ 80 % overall, ≥ 90 % on the listed modules (the eligibility gate joined with P2-02). */
const COVERAGE_THRESHOLD = 80;
const MODULE_THRESHOLD = 90;
/** Compiler branches: 87.4 % at the Phase 1 review (D-27), raised to 90 % by P2-44. */
const COMPILER_BRANCH_FLOOR = 90;
const RUNNER_TIMEOUT_MS = 30_000;
const moduleGate = { lines: MODULE_THRESHOLD, branches: MODULE_THRESHOLD, functions: MODULE_THRESHOLD, statements: MODULE_THRESHOLD };

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
    // A runner safety net, not a budget (P2-47 stability): the heaviest tests (whole-pipeline builds, uBO's
    // scriptlet library, the full registration set) take ≈ 1.2 s at load 10 and passed 5 s at load ≥ 30.
    // Timing budgets live in `vitest.perf.config.ts` (`npm run test:perf`).
    // P2-40: the pages read their copy through chrome.i18n; tests get Chrome's lookup over _locales/en.
    setupFiles: ['tests/unit/setup/i18n.ts'],
    testTimeout: RUNNER_TIMEOUT_MS,
    hookTimeout: RUNNER_TIMEOUT_MS,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'compiler/**/*.ts'],
      // WXT entry files only wire listeners; they run in the real worker and are covered by E2E
      // (worker-side coverage is not collected in v1, testing notes §2).
      // Compiler CLIs (`main.ts`, `cli-*.ts`) and the network/file ports only wire I/O; the logic behind them is unit-tested.
      exclude: ['src/entrypoints/**', 'compiler/**/main.ts', 'compiler/**/cli-*.ts', 'compiler/**/node-ports.ts'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        lines: COVERAGE_THRESHOLD,
        branches: COVERAGE_THRESHOLD,
        functions: COVERAGE_THRESHOLD,
        statements: COVERAGE_THRESHOLD,
        'compiler/**': { ...moduleGate, branches: COMPILER_BRANCH_FLOOR },
        'src/core/messaging/**': moduleGate,
        'src/core/reconcile/**': moduleGate,
        'src/core/sanitise/**': moduleGate,
        'compiler/eligibility/**': moduleGate,
      },
    },
  },
});
