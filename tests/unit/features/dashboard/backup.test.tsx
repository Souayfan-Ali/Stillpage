// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Dashboard } from '../../../../src/core/messaging/dashboard.js';
import { MAX_BACKUP_BYTES } from '../../../../src/core/limits.js';
import { exportBackup } from '../../../../src/core/state/backup.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import { BackupSection } from '../../../../src/features/dashboard/backup/BackupSection.js';
import { createRestoreStore, type FileLike } from '../../../../src/features/dashboard/backup/backupStore.js';
import { backupFileName } from '../../../../src/features/dashboard/backup/download.js';
import { changeText, droppedText } from '../../../../src/features/dashboard/backup/strings.js';
import { axeViolations } from '../../ui/axe.js';
import { dashboard, scripted } from './fixtures.js';

afterEach(cleanup);

const NOW = 1_763_100_000_000;
const DIGEST = 'ab'.repeat(32);
const BEFORE = createDefaultSettings();
const DROPPED = [{ pack: 'reg-xx', reason: 'unavailable' }];
const ANSWER = { before: BEFORE, after: { ...BEFORE, defaultLevel: 'light' }, dropped: DROPPED, filters: null, digest: DIGEST };
const file = (text: string, size = text.length): FileLike => ({ size, text: () => Promise.resolve(text) });
const good = (): string => exportBackup({ ...createDefaultSettings(), defaultLevel: 'light' }, NOW);

function setup(data: Dashboard = dashboard(), answers: Parameters<typeof scripted>[1] = {}) {
  const request = scripted(() => data, { 'q/previewBackup': { ok: true, data: ANSWER }, 'c/importBackup': { ok: true, data: { status: 'applied', dropped: DROPPED, filters: 'none' } }, ...answers });
  const onRestored = vi.fn(() => Promise.resolve());
  const restore = createRestoreStore(request, onRestored, () => dashboard().packs);
  const say = vi.fn();
  const view = render(<BackupSection data={data} restore={restore} now={() => NOW} say={say} />);
  return { request, restore, onRestored, say, view };
}

describe('hidden items in backups (P2-22)', () => {
  test('save: the file carries the hidden items the dashboard shows', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const blob = vi.spyOn(globalThis, 'Blob');
    setup(dashboard({ hidden: [{ host: 'news.example', selectors: ['#ad'] }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Save backup file' }));
    const text = (blob.mock.calls[0]?.[0] as string[])[0] ?? '';
    expect(JSON.parse(text)).toMatchObject({ version: 2, userFilters: { 'news.example': ['#ad'] } });
    vi.restoreAllMocks();
  });

  test('save without a readable list: the file has no user filters, so a restore keeps the device’s', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const blob = vi.spyOn(globalThis, 'Blob');
    setup(dashboard({ hidden: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Save backup file' }));
    expect(JSON.parse((blob.mock.calls[0]?.[0] as string[])[0] ?? '')).not.toHaveProperty('userFilters');
    vi.restoreAllMocks();
  });

  test('preview: one line for the hidden items added and removed', async () => {
    const filters = { before: { 'a.example': ['#a', '#b'] }, after: { 'a.example': ['#a'], 'b.example': ['#c', '#d'] } };
    const { restore } = setup(dashboard(), { 'q/previewBackup': { ok: true, data: { ...ANSWER, filters } } });
    await restore.choose(file(good()));
    expect(screen.getByText('Hidden items: 2 added, 1 removed')).toBeTruthy();
  });
});

describe('Backup section (P2-37)', () => {
  test('save: a JSON file named by the date; the status says so', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { say } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Save backup file' }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('Backup file saved.');
    expect(backupFileName('glassmere-backup', NOW)).toBe('glassmere-backup-2025-11-14.json');
    vi.restoreAllMocks();
    expect(revoke).toBeDefined();
  });

  test('restore: preview first, nothing sent until "Restore"; then the snapshot is re-read', async () => {
    const { restore, request, onRestored, view } = setup();
    await restore.choose(file(good()));
    expect(screen.getByText('Default level: Standard → Light')).toBeTruthy();
    expect(screen.getByText(/not in this version, left out/)).toBeTruthy();
    expect(request).not.toHaveBeenCalledWith('c/importBackup', expect.anything(), expect.anything());
    expect(await axeViolations(view.container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await screen.findByText('Backup restored.');
    expect(request).toHaveBeenCalledWith('c/importBackup', { json: good(), expect: DIGEST }, expect.anything());
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  test('cancel drops the preview', async () => {
    const { restore } = setup();
    await restore.choose(file(good()));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  test.each([
    ['too large', file('{}', MAX_BACKUP_BYTES + 1), 'too large'],
    ['not JSON', file('<html>'), 'not a backup: it could not be read'],
    ['another format', file('{"format":"x"}'), 'not a backup made by this extension'],
    ['a newer version', file('{"format":"glassmere-backup","version":7}'), 'newer version'],
    ['a hand-edited file', file(good().replace('"gpc"', '"evil": 1, "gpc"')), 'damaged or was changed'],
    ['an unreadable file', { size: 3, text: () => Promise.reject(new Error('io')) }, 'could not be read'],
  ] as const)('a hostile or broken file (%s) is refused before the worker is asked', async (_name, f, words) => {
    const { restore, request } = setup();
    await restore.choose(f);
    expect((await screen.findByRole('alert')).textContent).toContain(words);
    expect(request).not.toHaveBeenCalledWith('q/previewBackup', expect.anything(), expect.anything());
    expect(screen.getByLabelText('Backup file').getAttribute('aria-describedby')).toContain('backup-problem');
  });

  test('the worker refusing the preview or the import is shown, nothing restored', async () => {
    const refused = { ok: false, error: { code: 'refused', reason: 'invalid-payload' } } as const;
    const first = setup(dashboard(), { 'q/previewBackup': refused });
    await first.restore.choose(file(good()));
    expect((await screen.findByRole('alert')).textContent).toContain('damaged');
    cleanup();
    const second = setup(dashboard(), { 'c/importBackup': { ok: false, error: { code: 'refused', reason: 'internal' } } });
    await second.restore.choose(file(good()));
    await second.restore.restore();
    expect((await screen.findByRole('alert')).textContent).toBe('Nothing was restored. Try again.');
    expect(second.onRestored).not.toHaveBeenCalled();
    cleanup();
    const stale = setup(dashboard(), { 'c/importBackup': { ok: false, error: { code: 'refused', reason: 'invalid-payload' } } });
    await stale.restore.choose(file(good()));
    await stale.restore.restore();
    expect((await screen.findByRole('alert')).textContent).toContain('changed since this preview');
    cleanup();
    const silent = setup(dashboard(), { 'c/importBackup': { ok: false, error: { code: 'no-answer' } } });
    await silent.restore.choose(file(good()));
    await silent.restore.restore();
    expect((await screen.findByRole('alert')).textContent).toContain('may still be restoring');
    expect(silent.onRestored).toHaveBeenCalledTimes(1);
  });

  test('D-32: after a reset the section says a backup brings the settings back', () => {
    setup(dashboard({ settingsReset: true }));
    expect(screen.getByText(/Your settings were reset/)).toBeTruthy();
  });

  test('a file chosen in the input goes to the restore flow', async () => {
    const { restore } = setup();
    const choose = vi.spyOn(restore, 'choose');
    const input = screen.getByLabelText('Backup file');
    const chosen = new File([good()], 'b.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [chosen] });
    fireEvent.change(input);
    await waitFor(() => {
      expect(choose).toHaveBeenCalledWith(chosen);
    });
  });

  test('changes that lower protection are said on their own (security review M1)', async () => {
    const after = { ...BEFORE, siteLevels: { 'a.example': 'off', 'b.example': 'off' }, popups: { ...BEFORE.popups, sites: { 'pay.example': 'allow' } } };
    const { restore } = setup(dashboard(), { 'q/previewBackup': { ok: true, data: { ...ANSWER, after } } });
    await restore.choose(file(good()));
    expect(screen.getByText(/This lowers your protection: 2 sites will be set to Off, so nothing is blocked there: a.example, b.example. 1 site will be allowed to open pop-ups: pay.example./)).toBeTruthy();
  });

  test('P2-43 (A-1): the warnings name at most 10 hosts, then how many more', async () => {
    const hosts = Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, '0')}.example`);
    const after = { ...BEFORE, siteLevels: Object.fromEntries(hosts.map((h) => [h, 'off'])) };
    const { restore } = setup(dashboard(), { 'q/previewBackup': { ok: true, data: { ...ANSWER, after } } });
    await restore.choose(file(good()));
    expect(screen.getByText(/12 sites will be set to Off, so nothing is blocked there: s00.example, s01.example, .*s09.example and 2 more\./)).toBeTruthy();
  });

  test('stored but not applied: said so, and the snapshot is re-read', async () => {
    const { restore, onRestored } = setup(dashboard(), { 'c/importBackup': { ok: true, data: { status: 'failed', dropped: [], filters: 'none' } } });
    await restore.choose(file(good()));
    await restore.restore();
    expect(await screen.findByText(/restored, but applying it failed/)).toBeTruthy();
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  test('settings restored but the hidden items changed meanwhile: said so, not "tried again" (design review Q4)', async () => {
    const { restore, onRestored } = setup(dashboard(), { 'c/importBackup': { ok: true, data: { status: 'applied', dropped: [], filters: 'kept' } } });
    await restore.choose(file(good()));
    await restore.restore();
    expect(await screen.findByText('Your settings were restored. Your hidden items changed meanwhile and were left as they are. Choose the file again to restore them.')).toBeTruthy();
    expect(screen.queryByText(/tried again/)).toBeNull();
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  test('only the newest chosen file is previewed', async () => {
    let release: (text: string) => void = () => undefined;
    const slow: FileLike = { size: 10, text: () => new Promise((resolve) => (release = resolve)) };
    const { restore } = setup();
    const first = restore.choose(slow);
    await restore.choose(file('<html>'));
    release(good());
    await first;
    expect(restore.state.value.kind).toBe('problem');
  });

  test('every change kind has a plain line', () => {
    const lines = [
      changeText({ kind: 'pack', pack: 'cookies', to: true }),
      changeText({ kind: 'siteLevels', added: 2, removed: 1, changed: 0, weakened: 0, weakenedHosts: [] }),
      changeText({ kind: 'popupMode', from: 'off', to: 'smart' }),
      changeText({ kind: 'popupSites', added: 0, removed: 0, changed: 3, weakened: 0, weakenedHosts: [] }),
      changeText({ kind: 'popupNotice', to: false }),
      changeText({ kind: 'gpc', to: true }),
      changeText({ kind: 'badge', to: false }),
      changeText({ kind: 'theme', to: 'dark' }),
      droppedText({ pack: 'cookies', reason: 'rule-pool' }),
      droppedText({ pack: 'popups', reason: 'not-toggleable' }),
      droppedText({ reason: 'suffix', hosts: ['co.uk', 'com'] }),
    ];
    expect(lines).toEqual([
      'Cookie banners: turned on',
      'Site levels: 2 added, 1 removed',
      'Pop-up blocking: Off → Smart',
      'Pop-up choices per site: 3 changed',
      '"Tell me when a pop-up is blocked": off',
      '"Do not sell or share" signal: on',
      'Blocked count on the toolbar icon: off',
      'Colours: dark',
      'Cookie banners: not enough room now, left off',
      'Known pop-up ad sites: cannot be set by a backup, left as it is',
      'Skipped co.uk, com: each would cover every site ending in it. Add one again under Sites if you meant it',
    ]);
  });
});
