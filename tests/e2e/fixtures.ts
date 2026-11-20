import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, test as base, type BrowserContext, type Worker } from '@playwright/test';
import { closeOnboardingTab, expectsOnboardingTab } from './helpers/onboardingTab.js';

/** The unpacked build produced by `wxt build` (testing notes §6: tests run against the built artefact). */
const EXTENSION_DIR = path.resolve(import.meta.dirname, '../../.output/chrome-mv3');

interface ExtensionFixtures {
  readonly context: BrowserContext;
  readonly serviceWorker: Worker;
  readonly extensionId: string;
}

/**
 * Bundled Chromium with a throwaway profile and only our extension loaded.
 * `channel: 'chromium'` is required for extensions in headless mode (research notes 03 §5.2).
 */
export const test = base.extend<ExtensionFixtures>({
  // Playwright requires the destructuring form for fixtures with no dependencies.
  context: async ({}, use) => {
    const profileDir = await mkdtemp(path.join(tmpdir(), 'glassmere-e2e-'));
    try {
      const onboarding = expectsOnboardingTab(profileDir, EXTENSION_DIR);
      const context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chromium',
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
      });
      try {
        // D-46: the first-run tab of the fresh install is closed before the test sees the context.
        if (onboarding) await closeOnboardingTab(context);
        await use(context);
      } finally {
        await context.close();
      }
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  },
  serviceWorker: async ({ context }, use) => {
    const existing = context.serviceWorkers()[0];
    await use(existing ?? (await context.waitForEvent('serviceworker')));
  },
  extensionId: async ({ serviceWorker }, use) => {
    const id = new URL(serviceWorker.url()).host;
    await use(id);
  },
});

export const { expect } = test;
