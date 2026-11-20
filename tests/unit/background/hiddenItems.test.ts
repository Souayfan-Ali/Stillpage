/**
 * P2-22 through the worker: the hidden-items list in `q/dashboard`, the count in `q/tabState`, removal
 * from the dashboard (a page in a tab), and user filters in backups (format version 2): preview, import
 * (vault, then the `uf:*` mirror), version 1 files keep the device's filters.
 */
import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { createWorker } from '../../../src/background/worker.js';
import type { RulesetId } from '../../../src/core/ids.js';
import { DashboardAnswerSchema } from '../../../src/core/messaging/dashboardSchema.js';
import { TabStateSchema } from '../../../src/core/messaging/tabState.js';
import { BACKUP_FORMAT, exportBackup } from '../../../src/core/state/backup.js';
import { PreviewAnswerSchema } from '../../../src/core/state/backupPreview.js';
import { USER_FILTERS_KEY, type UserFilters } from '../../../src/core/userFilters/store.js';
import type { UserPorts } from '../../../src/platform/userPorts.js';
import { createFakeBrowser } from '../platform/fakes/browser.js';
import { NOW, settings, testCatalog } from '../core/reconcile/fixtures.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${ID}`;
const page = (path: string, extra: object = {}): object => ({ id: ID, url: `${ORIGIN}/${path}`, origin: ORIGIN, ...extra });
/** The dashboard is the options page, opened in a tab (top frame). */
const DASHBOARD = page('dashboard.html#hidden', { tab: { id: 9 }, frameId: 0 });
const POPUP = page('popup.html');
const TAB = 7;
const rulesets = ['ubo', 'ubo-x', 'easyprivacy', 'cookies', 'cookies-x', 'popups'].map((id) => ({ id: id as RulesetId, enabled: !id.endsWith('-x'), regexCount: 1 }));
const FILTERS: UserFilters = { v: 1, hosts: { 'news.example': ['#ad', '.promo'], 'shop.example': ['#chat'] } as UserFilters['hosts'] };

let counter = 0;
const msg = (type: string, payload: unknown): unknown => ({ v: 1, type, id: `h${String((counter += 1))}`, payload });

function setup(options: { readonly failFilterWrite?: boolean } = {}) {
  const b = createFakeBrowser({ rulesets, catalog: testCatalog(), now: () => NOW });
  // The filter write of a restore fails (it happens after the settings write: the race of design review Q4).
  const vault = options.failFilterWrite === true
    ? { ...b.ports.vault, set: (key: string, value: unknown) => (key === USER_FILTERS_KEY ? Promise.reject(new Error('io')) : b.ports.vault.set(key, value)) }
    : b.ports.vault;
  let local: Record<string, unknown> = {};
  const user: UserPorts = {
    local: {
      getAll: () => Promise.resolve({ ...local }),
      set: (items) => { local = { ...local, ...items }; return Promise.resolve(); },
      remove: (keys) => { local = Object.fromEntries(Object.entries(local).filter(([k]) => !keys.includes(k))); return Promise.resolve(); },
    },
    injectPicker: () => Promise.resolve(),
    sendToTopFrame: () => Promise.resolve(undefined),
    activeTabIds: () => Promise.resolve([TAB]),
  };
  b.setTab(TAB, 'https://www.news.example/article');
  const worker = createWorker({ ...b.ports, vault, user }, ID);
  const send = (type: string, payload: unknown, sender: object = DASHBOARD): Promise<unknown> => worker.handlers.message(msg(type, payload), sender);
  return { b, send, mirror: () => local };
}

const dashboardFilters = async (send: ReturnType<typeof setup>['send']): Promise<unknown> => {
  const answer = (await send('q/dashboard', {})) as { ok: true; data: unknown };
  return v.parse(DashboardAnswerSchema, answer.data).userFilters;
};

describe('the list and the count (P2-22)', () => {
  test('q/dashboard answers the filters per host; null when the vault value cannot be read', async () => {
    const s = setup();
    expect(await dashboardFilters(s.send)).toEqual({});
    await s.b.ports.vault.set(USER_FILTERS_KEY, FILTERS);
    expect(await dashboardFilters(s.send)).toEqual(FILTERS.hosts);
    await s.b.ports.vault.set(USER_FILTERS_KEY, { v: 9 });
    expect(await dashboardFilters(s.send)).toBeNull();
  });

  test('q/tabState lists the filters that apply on the tab (stored without www., so they apply; P2-22b)', async () => {
    const s = setup();
    await s.b.ports.vault.set(USER_FILTERS_KEY, FILTERS);
    const answer = (await s.send('q/tabState', { tabId: TAB }, POPUP)) as { ok: true; data: unknown };
    expect(v.parse(TabStateSchema, answer.data).hidden).toEqual(['#ad', '.promo']);
  });
});

describe('remove from the dashboard (P2-22)', () => {
  test('the dashboard, in its tab, removes a filter: vault, then mirror', async () => {
    const s = setup();
    await s.b.ports.vault.set(USER_FILTERS_KEY, FILTERS);
    expect(await s.send('c/removeUserFilter', { hostname: 'news.example', selector: '#ad' })).toEqual({ ok: true, data: null });
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toEqual({ v: 1, hosts: { 'news.example': ['.promo'], 'shop.example': ['#chat'] } });
    expect(s.mirror()).toEqual({ 'uf:news.example': { v: 1, s: ['.promo'] }, 'uf:shop.example': { v: 1, s: ['#chat'] } });
  });

  test('refused: the dashboard in a frame, a page that is not ours, the blocked page', async () => {
    const s = setup();
    await s.b.ports.vault.set(USER_FILTERS_KEY, FILTERS);
    const payload = { hostname: 'news.example', selector: '#ad' };
    for (const sender of [page('dashboard.html', { tab: { id: 9 }, frameId: 4 }), page('blocked.html', { tab: { id: 9 }, frameId: 0 }), { id: ID, url: 'https://news.example/', tab: { id: 9 }, frameId: 0 }]) {
      expect(await s.send('c/removeUserFilter', payload, sender)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    }
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toEqual(FILTERS);
  });
});

describe('user filters in backups (format version 2, P2-22)', () => {
  const restore = async (send: ReturnType<typeof setup>['send'], json: string): Promise<{ preview: unknown; result: unknown }> => {
    const preview = (await send('q/previewBackup', { json })) as { ok: boolean; data?: { digest: string } };
    return { preview, result: await send('c/importBackup', { json, expect: preview.data?.digest ?? 'ab'.repeat(32) }) };
  };

  test('preview answers the filters now and in the file; import replaces them and re-derives the mirror', async () => {
    const s = setup();
    await s.b.ports.vault.set(USER_FILTERS_KEY, FILTERS);
    const next: UserFilters = { v: 1, hosts: { 'blog.example': ['#cookie'] } as UserFilters['hosts'] };
    const { preview, result } = await restore(s.send, exportBackup(settings(), NOW, next));
    expect(v.parse(PreviewAnswerSchema, (preview as { data: unknown }).data).filters).toEqual({ before: FILTERS.hosts, after: next.hosts });
    expect(result).toMatchObject({ ok: true, data: { filters: 'replaced' } });
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toEqual(next);
    expect(s.mirror()).toEqual({ 'uf:blog.example': { v: 1, s: ['#cookie'] } });
  });

  test('D-62: hidden items for a single-label host survive a same-device round trip; an unknown one is skipped and named', async () => {
    const s = setup();
    const device: UserFilters = { v: 1, hosts: { nas: ['#banner'], 'news.example': ['#ad'] } as UserFilters['hosts'] };
    await s.b.ports.vault.set(USER_FILTERS_KEY, device);
    const file: UserFilters = { v: 1, hosts: { nas: ['#banner', '.promo'], router: ['body'] } as UserFilters['hosts'] };
    const { preview, result } = await restore(s.send, exportBackup(settings(), NOW, file));
    expect(v.parse(PreviewAnswerSchema, (preview as { data: unknown }).data).dropped).toEqual([{ reason: 'suffix', hosts: ['router'] }]);
    expect(result).toMatchObject({ ok: true, data: { filters: 'replaced' } });
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toEqual({ v: 1, hosts: { nas: ['#banner', '.promo'] } });
  });

  test('a version 1 file keeps the device’s filters (preview: no filter change)', async () => {
    const s = setup();
    await s.b.ports.vault.set(USER_FILTERS_KEY, FILTERS);
    const v1 = JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: NOW, settings: (JSON.parse(exportBackup(settings({ defaultLevel: 'light' }), NOW)) as { settings: unknown }).settings });
    const { preview, result } = await restore(s.send, v1);
    expect((preview as { data: { filters: unknown } }).data.filters).toBeNull();
    expect(result).toMatchObject({ ok: true, data: { filters: 'none' } });
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toEqual(FILTERS);
  });

  test('the digest covers the filters: a filter removed after the preview makes the import stale', async () => {
    const s = setup();
    await s.b.ports.vault.set(USER_FILTERS_KEY, FILTERS);
    const json = exportBackup(settings(), NOW, { v: 1, hosts: {} });
    const preview = (await s.send('q/previewBackup', { json })) as { data: { digest: string } };
    expect(await s.send('c/removeUserFilter', { hostname: 'shop.example', selector: '#chat' })).toMatchObject({ ok: true });
    expect(await s.send('c/importBackup', { json, expect: preview.data.digest })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toEqual({ v: 1, hosts: { 'news.example': ['#ad', '.promo'] } });
  });

  test('an unreadable filter store is never overwritten by a restore that carries filters', async () => {
    const s = setup();
    await s.b.ports.vault.set(USER_FILTERS_KEY, { v: 9 });
    const { preview, result } = await restore(s.send, exportBackup(settings(), NOW, FILTERS));
    expect(preview).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(result).toMatchObject({ ok: false });
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toEqual({ v: 9 });
  });

  test('settings stored but the filters could not be replaced: answered `filters: kept` with the real run status (design review Q4)', async () => {
    const s = setup({ failFilterWrite: true });
    await s.b.ports.vault.set(USER_FILTERS_KEY, FILTERS);
    const { result } = await restore(s.send, exportBackup(settings({ defaultLevel: 'light' }), NOW, { v: 1, hosts: {} }));
    expect(result).toMatchObject({ ok: true, data: { filters: 'kept' } });
    expect((result as { data: { status: string } }).data.status).not.toBe('failed');
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toEqual(FILTERS);
  });
});
