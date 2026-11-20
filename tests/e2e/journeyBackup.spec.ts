/**
 * J12 (backup export → fresh profile → import, state equal) and the J14 restore step (D-32: "Restore a
 * backup" on the reset notice, the notice cleared after the restore), P2-37, on the real build with
 * throwaway profiles. A hand-edited file is refused with nothing stored.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { BUILD_DIR } from './helpers/fixtureExtension.js';
import { closeAll, expectNoSurvivors, extensionWorker, launch, newProfile } from './helpers/browser.js';
import { applySettings } from './helpers/corpus.js';
import { vaultValue } from './helpers/session.js';
import { expectAccessible, extensionIdOf, openPage, POLL, send, settled } from './helpers/settingsPages.js';

test.setTimeout(180_000);

test.afterEach(async () => {
  await closeAll();
});

test.afterAll(async () => {
  await expectNoSurvivors();
});

/** The backed-up part of the stored settings (D-45: pauses and onboarding are device-local). */
async function portable(page: Page): Promise<unknown> {
  const answer = (await send(page, 'q/dashboard', {})) as { data: { settings: Record<string, unknown> } };
  const local = new Set(['pauses', 'onboarding', 'schemaVersion']);
  return Object.fromEntries(Object.entries(answer.data.settings).filter(([key]) => !local.has(key)));
}

/** Navigates the dashboard to `section` (a hash change). */
async function show(page: Page, section: string): Promise<void> {
  await page.goto(`${page.url().split('#')[0] ?? ''}#${section}`);
}

async function exportFrom(page: Page, dir: string): Promise<string> {
  await show(page, 'backup');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save backup file' }).click();
  const file = path.join(dir, (await download).suggestedFilename());
  await (await download).saveAs(file);
  return file;
}

async function restoreInto(page: Page, file: string): Promise<void> {
  await page.getByLabel('Backup file').setInputFiles(file);
  await expect(page.getByRole('heading', { name: 'This backup will change:' })).toBeVisible({ timeout: POLL.timeout });
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Backup restored.')).toBeVisible({ timeout: 120_000 });
}

test('J12: export, fresh profile, import: state equal', async () => {
  const profileA = await newProfile();
  const a = await launch(profileA, BUILD_DIR);
  const pageA = await openPage(a, 'dashboard.html');
  await settled(pageA);
  expect(await send(pageA, 'c/setDefaultLevel', { level: 'thorough' })).toMatchObject({ ok: true });
  expect(await send(pageA, 'c/setSiteLevel', { hostname: 'news.example', level: 'off' })).toMatchObject({ ok: true });
  expect(await send(pageA, 'c/setSiteLevel', { hostname: 'shop.example', level: 'light' })).toMatchObject({ ok: true });
  expect(await send(pageA, 'c/setGpc', { enabled: true })).toMatchObject({ ok: true });
  expect(await send(pageA, 'c/setShowBadge', { enabled: false })).toMatchObject({ ok: true });
  expect(await send(pageA, 'c/setSitePopupPolicy', { hostname: 'pay.example', policy: 'allow' })).toMatchObject({ ok: true });
  const wanted = await portable(pageA);
  const file = await exportFrom(pageA, profileA);
  const text = await readFile(file, 'utf8');
  expect(JSON.parse(text)).toMatchObject({ format: 'glassmere-backup', version: 2, userFilters: {} });
  await a.close();

  const b = await launch(await newProfile(), BUILD_DIR);
  const pageB = await openPage(b, 'dashboard.html#backup');
  await settled(pageB);
  await pageB.reload();
  await restoreInto(pageB, file);
  expect(await portable(pageB)).toEqual(wanted);
  await expect.poll(async () => pageB.evaluate(async () => (await chrome.declarativeNetRequest.getEnabledRulesets()).includes('gpc-x')), POLL).toBe(true);
});

test('J14: "Restore a backup" on the reset notice restores and clears the notice; a hand-edited file is refused', async () => {
  const profile = await newProfile();
  const context = await launch(profile, BUILD_DIR);
  const page = await openPage(context, 'dashboard.html');
  await settled(page);
  expect(await send(page, 'c/setDefaultLevel', { level: 'light' })).toMatchObject({ ok: true });
  const file = await exportFrom(page, profile);

  const worker = await extensionWorker(context);
  await applySettings(context, worker, await extensionIdOf(context), { schemaVersion: 1, defaultLevel: 'turbo' }, 'dashboard.html');
  await show(page, 'protection');
  await expect(page.getByText('Your settings were reset because they could not be read.')).toBeVisible({ timeout: POLL.timeout });

  const edited = path.join(profile, 'edited.json');
  await writeFile(edited, (await readFile(file, 'utf8')).replace('"gpc"', '"script": "alert(1)", "gpc"'));
  await page.getByRole('link', { name: 'Restore a backup' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Backup' })).toBeFocused();
  await page.getByLabel('Backup file').setInputFiles(edited);
  await expect(page.getByRole('alert')).toContainText('damaged or was changed by hand');
  expect(await vaultValue(page, 'settings')).toEqual({ schemaVersion: 1, defaultLevel: 'turbo' });

  await restoreInto(page, file);
  await expect(page.getByText('Your settings were reset because they could not be read.')).toHaveCount(0);
  expect(await vaultValue(page, 'notice')).toBeUndefined();
  expect(await send(page, 'q/dashboard', {})).toMatchObject({ ok: true, data: { settingsReset: false, settings: { defaultLevel: 'light' } } });
});
