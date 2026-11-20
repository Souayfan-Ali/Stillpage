/**
 * P2-34: the settings pages' messages through the real worker over the fake browser: who may send
 * each, the dashboard snapshot and the default level.
 */
import * as v from 'valibot';
import { describe, expect, test, vi } from 'vitest';
import type { RulesetId } from '../../../src/core/ids.js';
import { describeDashboard } from '../../../src/core/messaging/dashboard.js';
import { DashboardAnswerSchema } from '../../../src/core/messaging/dashboardSchema.js';
import { PreviewAnswerSchema } from '../../../src/core/state/backupPreview.js';
import { BACKUP_FORMAT, exportBackup } from '../../../src/core/state/backup.js';
import { createWorker } from '../../../src/background/worker.js';
import { NOTICE_KEY, SETTINGS_KEY } from '../../../src/background/settingsStore.js';
import type { Ports, UiPort } from '../../../src/platform/ports.js';
import { createFakeBrowser, type FakeBrowser } from '../platform/fakes/browser.js';
import { NOW, settings, testCatalog } from '../core/reconcile/fixtures.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const page = (path: string): object => ({ id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/${path}`, origin: `chrome-extension://${RUNTIME_ID}` });
const DASHBOARD = page('dashboard.html#sites');
const ONBOARDING = page('onboarding.html');
const POPUP = page('popup.html');
const BLOCKED = { ...page('blocked.html'), tab: { id: 3 }, frameId: 0 };
const CONTENT = { id: RUNTIME_ID, url: 'https://news.test/', origin: 'https://news.test', tab: { id: 7 }, frameId: 0 };
const rulesets = ['ubo', 'ubo-x', 'easyprivacy', 'cookies', 'cookies-x', 'popups'].map((id) => ({
  id: id as RulesetId,
  enabled: !id.endsWith('-x') && !id.startsWith('cookies'),
  regexCount: 1,
  ruleCount: 900,
}));

let counter = 0;
const msg = (type: string, payload: unknown): unknown => ({ v: 1, type, id: `m${String((counter += 1))}`, payload });

function setup(staticRules = 330_000, withUi = true) {
  const b: FakeBrowser = createFakeBrowser({ rulesets, catalog: testCatalog(), now: () => NOW, limits: { staticRules } });
  const ui = { showActionCount: vi.fn<UiPort['showActionCount']>(() => Promise.resolve()), openOnboarding: vi.fn<UiPort['openOnboarding']>(() => Promise.resolve()) };
  const ports: Ports = withUi ? { ...b.ports, ui } : b.ports;
  const { handlers } = createWorker(ports, RUNTIME_ID);
  const send = (type: string, payload: unknown, sender: object = DASHBOARD): Promise<unknown> => handlers.message(msg(type, payload), sender);
  return { b, ui, handlers, send };
}

const stored = async (b: FakeBrowser): Promise<Record<string, unknown>> => (await b.ports.vault.get(SETTINGS_KEY)) as Record<string, unknown>;

describe('who may send the settings pages messages', () => {
  test.each([
    ['q/dashboard', {}, [DASHBOARD, ONBOARDING], [POPUP, BLOCKED, CONTENT]],
    ['q/previewBackup', { json: '{}' }, [DASHBOARD], [POPUP, ONBOARDING, BLOCKED, CONTENT]],
    ['c/importBackup', { json: '{}', expect: 'ab'.repeat(32) }, [DASHBOARD], [POPUP, ONBOARDING, BLOCKED, CONTENT]],
    ['c/completeOnboarding', {}, [ONBOARDING], [POPUP, DASHBOARD, BLOCKED, CONTENT]],
    ['c/setShowBadge', { enabled: false }, [DASHBOARD], [POPUP, ONBOARDING, BLOCKED, CONTENT]],
    ['c/forgetSites', { hostnames: ['a.test'] }, [DASHBOARD], [POPUP, ONBOARDING, BLOCKED, CONTENT]],
    ['c/setDefaultLevel', { level: 'light' }, [DASHBOARD, ONBOARDING, POPUP], [BLOCKED, CONTENT]],
    ['c/setSiteLevel', { hostname: 'a.test', level: 'off' }, [DASHBOARD, POPUP], [ONBOARDING, BLOCKED, CONTENT]],
  ] as const)('%s', async (type, payload, allowed, refused) => {
    const { send } = setup();
    for (const sender of refused) expect(await send(type, payload, sender)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    for (const sender of allowed) expect(await send(type, payload, sender)).not.toMatchObject({ error: { code: 'forbidden-sender' } });
  });
});

describe('q/dashboard', () => {
  test('answers a snapshot the page schema accepts: packs, capacity, notices', async () => {
    const { send } = setup();
    const answer = (await send('q/dashboard', {})) as { ok: true; data: unknown };
    expect(answer.ok).toBe(true);
    const data = describeDashboard(v.parse(DashboardAnswerSchema, answer.data));
    expect(data.packs.map((p) => [p.id, p.enabled, p.toggleable, p.ceiling])).toEqual([
      ['ads', true, true, 2000],
      ['trackers', true, true, 1000],
      ['cookies', false, true, 2000],
      ['popups', true, false, 1000],
    ]);
    expect(data.capacity).toEqual({ guaranteed: 30_000, usedCeiling: 3000, available: expect.any(Number) as number });
    expect(data).toMatchObject({ allSites: true, popupGuard: true, settingsReset: false, lastRun: 'none' });
  });

  test('reports a pack the capacity check leaves out, and a waiting notice', async () => {
    const { b, send } = setup(4_200);
    await b.ports.vault.set(SETTINGS_KEY, { ...settings({ cookieBanners: 'hide' }) });
    await b.ports.vault.set(NOTICE_KEY, { kind: 'settings-reset', reason: 'invalid', at: 1 });
    const data = describeDashboard(v.parse(DashboardAnswerSchema, ((await send('q/dashboard', {})) as { data: unknown }).data));
    expect(data.packs.find((p) => p.id === 'cookies')).toMatchObject({ enabled: true, skipped: 'rule-pool' });
    expect(data.settingsReset).toBe(true);
  });

  test('a dismissed notice is not shown', async () => {
    const { b, send } = setup();
    await b.ports.vault.set(NOTICE_KEY, { kind: 'settings-reset', reason: 'invalid', at: 1, dismissedAt: 2 });
    expect(await send('q/dashboard', {})).toMatchObject({ ok: true, data: { settingsReset: false } });
  });
});

describe('setting commands', () => {
  test('c/setDefaultLevel is stored and reconciled', async () => {
    const { b, send } = setup();
    expect(await send('c/setDefaultLevel', { level: 'thorough' })).toMatchObject({ ok: true, data: { status: 'applied' } });
    expect(await stored(b)).toMatchObject({ defaultLevel: 'thorough' });
  });

  test('c/forgetSites clears level, pause and pop-up policy of each host in one write (P2-35)', async () => {
    const { b, send } = setup();
    const before = { ...settings({ siteLevels: { 'a.test': 'off', 'b.test': 'light' }, pauses: { 'a.test': NOW + 1000 } }), popups: { mode: 'off', sites: { 'a.test': 'allow' }, notice: true } };
    await b.ports.vault.set(SETTINGS_KEY, before);
    expect(await send('c/forgetSites', { hostnames: ['a.test'] })).toMatchObject({ ok: true });
    expect(await stored(b)).toMatchObject({ siteLevels: { 'b.test': 'light' }, pauses: {}, popups: { sites: {} } });
  });

  test('c/forgetSites refuses an empty list and a bad hostname', async () => {
    const { send } = setup();
    expect(await send('c/forgetSites', { hostnames: [] })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await send('c/forgetSites', { hostnames: ['https://a.test/'] })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
  });

  test('a vault failure is an internal error, not a throw', async () => {
    const { b, send } = setup();
    b.failNext('vault.set');
    expect(await send('c/setDefaultLevel', { level: 'light' })).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  test('a catalog failure answers q/dashboard with an internal error', async () => {
    const { b, send } = setup();
    b.failNext('catalog.read');
    expect(await send('q/dashboard', {})).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});

describe('first run (P2-33)', () => {
  test('install opens the onboarding tab once; an update does not', async () => {
    const { ui, handlers } = setup();
    handlers.installed('install');
    await vi.waitFor(() => {
      expect(ui.openOnboarding).toHaveBeenCalledTimes(1);
    });
    handlers.installed('update');
    await vi.waitFor(() => {
      expect(ui.showActionCount).toHaveBeenCalledTimes(2);
    });
    expect(ui.openOnboarding).toHaveBeenCalledTimes(1);
  });

  test('a failing tab is logged, never thrown; the badge is still applied', async () => {
    const { b, ui, handlers } = setup();
    ui.openOnboarding.mockRejectedValueOnce(new Error('no window'));
    handlers.installed('install');
    await vi.waitFor(() => {
      expect(ui.showActionCount).toHaveBeenCalledWith(true);
    });
    expect(b.logs().some((l) => l.includes('onboarding tab'))).toBe(true);
  });

  test('c/completeOnboarding stamps the time; nothing else changes', async () => {
    const { b, send } = setup();
    expect(await send('c/completeOnboarding', {}, ONBOARDING)).toMatchObject({ ok: true });
    expect(await stored(b)).toMatchObject({ onboarding: { completedAt: NOW }, defaultLevel: 'standard', packs: {} });
  });
});

describe('badge (P2-36)', () => {
  test('c/setShowBadge stores the choice and the action count follows', async () => {
    const { b, ui, send } = setup();
    expect(await send('c/setShowBadge', { enabled: false })).toMatchObject({ ok: true });
    expect(await stored(b)).toMatchObject({ ui: { showBadge: false } });
    expect(ui.showActionCount).toHaveBeenLastCalledWith(false);
  });

  test('install and update apply the stored choice', async () => {
    const { ui, handlers } = setup();
    handlers.installed('install');
    await vi.waitFor(() => {
      expect(ui.showActionCount).toHaveBeenCalledWith(true);
    });
    handlers.installed('update');
    await vi.waitFor(() => {
      expect(ui.showActionCount).toHaveBeenCalledTimes(2);
    });
  });

  test('a failing badge call is logged, never thrown', async () => {
    const { b, ui, handlers } = setup();
    ui.showActionCount.mockRejectedValueOnce(new Error('nope'));
    handlers.installed('install');
    await vi.waitFor(() => {
      expect(b.logs().filter((l) => l.includes('badge option'))).toHaveLength(1);
    });
  });

  test('without a UI port (fakes) nothing happens', async () => {
    const { b, send } = setup(330_000, false);
    expect(await send('c/setShowBadge', { enabled: true })).toMatchObject({ ok: true });
    expect(b.logs().filter((l) => l.includes('badge'))).toEqual([]);
  });
});

describe('backup preview and import (P2-37)', () => {
  const backupOf = (s: object): string => exportBackup({ ...settings(), ...s }, NOW);
  /** Previews `json`, then imports it with the preview's digest, as the page does. */
  const restore = async (send: (type: string, payload: unknown) => Promise<unknown>, json: string): Promise<unknown> => {
    const preview = (await send('q/previewBackup', { json })) as { ok: boolean; data?: { digest: string } };
    return send('c/importBackup', { json, expect: preview.data?.digest ?? 'ab'.repeat(32) });
  };

  test('preview answers the settings now and after, a valid shape for the page, and stores nothing', async () => {
    const { b, send } = setup();
    const answer = (await send('q/previewBackup', { json: backupOf({ defaultLevel: 'light', gpc: true }) })) as { ok: true; data: unknown };
    const data = v.parse(PreviewAnswerSchema, answer.data);
    expect(data).toMatchObject({ before: { defaultLevel: 'standard', gpc: false }, after: { defaultLevel: 'light', gpc: true }, dropped: [] });
    expect(await b.ports.vault.get(SETTINGS_KEY)).toBeUndefined();
  });

  test('import stores the backed-up settings, keeps local pauses and reconciles', async () => {
    const { b, ui, send } = setup();
    await b.ports.vault.set(SETTINGS_KEY, settings({ pauses: { 'x.test': NOW + 5000 } }));
    const answer = await restore(send, backupOf({ defaultLevel: 'light', siteLevels: { 'a.test': 'off' }, ui: { theme: 'dark', showBadge: false } }) );
    expect(answer).toMatchObject({ ok: true, data: { status: 'applied', dropped: [] } });
    expect(await stored(b)).toMatchObject({ defaultLevel: 'light', siteLevels: { 'a.test': 'off' }, pauses: { 'x.test': { until: NOW + 5000 } }, ui: { theme: 'dark', showBadge: false } });
    expect(ui.showActionCount).toHaveBeenLastCalledWith(false);
  });

  test('P2-43 (A-1, design review): entries for a whole suffix are dropped, named in the preview, and not stored', async () => {
    const { b, send } = setup();
    const json = backupOf({ siteLevels: { com: 'off', 'co.uk': 'light', nas: 'off', localhost: 'off', 'a.test': 'off' } });
    const preview = (await send('q/previewBackup', { json })) as { ok: true; data: unknown };
    const data = v.parse(PreviewAnswerSchema, preview.data);
    expect(data.dropped).toEqual([{ reason: 'suffix', hosts: ['co.uk', 'com', 'nas'] }]);
    expect(data.after.siteLevels).toEqual({ localhost: 'off', 'a.test': 'off' });
    expect(await restore(send, json)).toMatchObject({ ok: true, data: { dropped: [{ reason: 'suffix', hosts: ['co.uk', 'com', 'nas'] }] } });
    expect((await stored(b) as { siteLevels: unknown }).siteLevels).toEqual({ localhost: 'off', 'a.test': 'off' });
  });

  test('D-62 (design review): a single-label host the device already holds in the same collection is kept; com still dropped', async () => {
    const { b, send } = setup();
    await b.ports.vault.set(SETTINGS_KEY, settings({ siteLevels: { nas: 'thorough' } }));
    const json = backupOf({ siteLevels: { nas: 'off', com: 'off', 'a.test': 'off' } });
    const preview = v.parse(PreviewAnswerSchema, ((await send('q/previewBackup', { json })) as { data: unknown }).data);
    expect(preview.before.siteLevels).toEqual({ nas: 'thorough' });
    expect(preview.dropped).toEqual([{ reason: 'suffix', hosts: ['com'] }]);
    expect(await restore(send, json)).toMatchObject({ ok: true, data: { dropped: [{ reason: 'suffix', hosts: ['com'] }] } });
    expect((await stored(b) as { siteLevels: unknown }).siteLevels).toEqual({ nas: 'off', 'a.test': 'off' });
  });

  test('a pack that does not fit is dropped, not stored', async () => {
    const { b, send } = setup(4_200);
    const answer = await restore(send, backupOf({ cookieBanners: 'hide' }) );
    expect(answer).toMatchObject({ ok: true, data: { dropped: [{ pack: 'cookies', reason: 'rule-pool' }] } });
    expect(await stored(b)).toMatchObject({ cookieBanners: 'leave' });
  });

  test.each([
    ['not JSON', 'not json'],
    ['another format', JSON.stringify({ format: 'other', version: 1 })],
    ['a newer version', JSON.stringify({ format: BACKUP_FORMAT, version: 9, exportedAt: 1, settings: {} })],
    ['an extra key', backupOf({}).replace('"gpc"', '"evil": 1, "gpc"')],
  ])('refuses %s; nothing stored, the notice stays', async (_name, json) => {
    const { b, send } = setup();
    await b.ports.vault.set(NOTICE_KEY, { kind: 'settings-reset', reason: 'invalid', at: 1 });
    expect(await send('q/previewBackup', { json })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await restore(send, json)).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await b.ports.vault.get(SETTINGS_KEY)).toBeUndefined();
    expect(await b.ports.vault.get(NOTICE_KEY)).toEqual({ kind: 'settings-reset', reason: 'invalid', at: 1 });
  });

  test('refuses a payload over the size cap at the envelope', async () => {
    const { send } = setup();
    expect(await send('c/importBackup', { json: 'x'.repeat(2 * 1024 * 1024 + 1), expect: 'ab'.repeat(32) })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
  });

  test('D-32: a successful restore clears the reset notice', async () => {
    const { b, send } = setup();
    await b.ports.vault.set(NOTICE_KEY, { kind: 'settings-reset', reason: 'invalid', at: 1 });
    expect(await restore(send, backupOf({}) )).toMatchObject({ ok: true });
    expect(await b.ports.vault.get(NOTICE_KEY)).toBeUndefined();
    expect(await send('q/dashboard', {})).toMatchObject({ ok: true, data: { settingsReset: false } });
  });

  test('M2: an import whose plan differs from the preview is refused, nothing stored', async () => {
    const { b, send } = setup();
    const json = backupOf({ defaultLevel: 'light' });
    const preview = (await send('q/previewBackup', { json })) as { data: { digest: string } };
    // A device-local change (kept by the restore) makes the resulting settings differ from the preview's.
    expect(await send('c/completeOnboarding', {}, ONBOARDING)).toMatchObject({ ok: true });
    expect(await send('c/importBackup', { json, expect: preview.data.digest })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await stored(b)).toMatchObject({ defaultLevel: 'standard' });
  });

  test('stored but the run failed: answered ok with status failed (the reconciler retries)', async () => {
    const { b, send } = setup();
    const json = backupOf({ defaultLevel: 'light', packs: { trackers: false } });
    const preview = (await send('q/previewBackup', { json })) as { data: { digest: string } };
    b.failNext('dnr.updateEnabledRulesets');
    const answer = (await send('c/importBackup', { json, expect: preview.data.digest })) as { ok: boolean; data: { status: string } };
    expect(answer).toMatchObject({ ok: true, data: { status: 'failed' } });
    expect(await stored(b)).toMatchObject({ defaultLevel: 'light' });
  });
});
