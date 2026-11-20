/**
 * The first-run tab (P2-33, D-46): the worker opens `onboarding.html` on every fresh install, also in
 * automated profiles. The shared launchers close it before handing the context to a test, so tests
 * that count tabs or wait for `page` events never see it; J1 opts out. Closing waits on the tab
 * itself (polled), never on a fixed delay.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';

const ONBOARDING_PATH = '/onboarding.html';
const APPEAR_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

const isOnboarding = (page: Page): boolean => {
  const url = page.url();
  return url.startsWith('chrome-extension://') && new URL(url).pathname === ONBOARDING_PATH;
};

/** True when a launch on `profileDir` with `extensionDir` will install the extension and open the tab. */
export function expectsOnboardingTab(profileDir: string, extensionDir: string): boolean {
  return !existsSync(path.join(profileDir, 'Default')) && existsSync(path.join(extensionDir, 'onboarding.html'));
}

/** Waits for the first-run tab and closes it. */
export async function closeOnboardingTab(context: BrowserContext, timeoutMs = APPEAR_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = context.pages().find(isOnboarding);
    if (tab !== undefined) {
      await tab.close();
      return;
    }
    if (Date.now() > deadline) throw new Error('the onboarding tab did not open after install');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
