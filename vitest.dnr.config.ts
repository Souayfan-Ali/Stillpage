import { defineConfig } from 'vitest/config';

/** Slow suites that drive the bundled Chromium (`npm run test:dnr`); not part of the unit gate. */
const TEST_TIMEOUT_MS = 60_000;

export default defineConfig({
  test: {
    include: ['tests/dnr/**/*.test.ts'],
    environment: 'node',
    testTimeout: TEST_TIMEOUT_MS,
    fileParallelism: false,
  },
});
