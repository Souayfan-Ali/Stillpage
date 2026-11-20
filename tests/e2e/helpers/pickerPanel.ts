/**
 * The picker panel's action buttons act only after they have been visible without interruption for
 * `VISIBLE_FOR_MS` (IntersectionObserver v2 clickjacking gate, J15/P2-42). A test that clicks one waits
 * until it is armed, as a user reading the panel would.
 */
import { expect, type Locator } from '@playwright/test';
import { VISIBLE_FOR_MS } from '../../../src/features/picker-panel/visibility.js';

/** Margin over the gate for the observer's 100 ms cadence on a loaded machine. */
const ARM_MARGIN_MS = 600;
const VISIBLE_WAIT = { timeout: 15_000 };

/** Waits until `button` reports visible (`aria-disabled="false"`) and the gate's time has passed. */
export async function armed(button: Locator): Promise<Locator> {
  await expect(button).toHaveAttribute('aria-disabled', 'false', VISIBLE_WAIT);
  await button.page().waitForTimeout(VISIBLE_FOR_MS + ARM_MARGIN_MS);
  return button;
}
