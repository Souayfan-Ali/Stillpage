/**
 * Turns the pop-up guard on as the product does (P2-57/P2-58): `c/setPopupMode` from the toolbar panel page,
 * then waits until the worker registered the guard scripts. Shared by J17 and J18.
 */
import { expect } from '@playwright/test';
import type { Session } from './session.js';

const REGISTERED = { timeout: 60_000 };

export async function enableGuard(s: Session, mode: 'smart' | 'strict'): Promise<void> {
  const page = await s.context.newPage();
  await page.goto(`chrome-extension://${s.id}/popup.html?tabId=1`);
  const answer: unknown = await page.evaluate((m) => chrome.runtime.sendMessage({ v: 1, type: 'c/setPopupMode', id: 'e2e-guard', payload: { mode: m } }), mode);
  expect(answer).toMatchObject({ ok: true });
  // Smart also registers `popup-strict` for the list-designated Strict sites; the guard pair must be there.
  await expect.poll(() => s.worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((r) => r.id).filter((id) => id.startsWith('popup-')).sort()), REGISTERED)
    .toEqual(expect.arrayContaining(mode === 'strict' ? ['popup-sentinel', 'popup-shim', 'popup-strict'] : ['popup-sentinel', 'popup-shim']));
  await page.close();
}
