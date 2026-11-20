import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { MAX_BACKUP_BYTES } from '../../../../src/core/limits.js';
import { BACKUP_FORMAT, exportBackup, readBackup, withBackup, type BackupSettings } from '../../../../src/core/state/backup.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import type { Settings } from '../../../../src/core/state/types.js';
import type { UserFilters } from '../../../../src/core/userFilters/store.js';

const NOW = 1_763_100_000_000;

const custom = (): Settings => ({
  ...createDefaultSettings(),
  defaultLevel: 'thorough',
  siteLevels: { 'a.example': 'off', 'b.example': 'light' } as Settings['siteLevels'],
  pauses: { 'c.example': { until: NOW + 60_000 } } as Settings['pauses'],
  packs: { 'annoy-social': true, 'reg-de': true } as Settings['packs'],
  cookieBanners: 'hide',
  popups: { mode: 'smart', sites: { 'pay.example': 'allow' } as Settings['popups']['sites'], notice: false },
  gpc: true,
  onboarding: { completedAt: NOW - 1000 },
  ui: { theme: 'dark', showBadge: false },
});

const file = (settings: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: NOW, settings, ...extra });

const backedUp = (s: Settings): BackupSettings => ({
  defaultLevel: s.defaultLevel,
  siteLevels: s.siteLevels,
  packs: s.packs,
  cookieBanners: s.cookieBanners,
  popups: s.popups,
  gpc: s.gpc,
  ui: s.ui,
});

const FILTERS: UserFilters = { v: 1, hosts: { 'a.example': ['#ad', '.banner'], 'news.example': ['#promo'] } as UserFilters['hosts'] };

describe('backup file version 2: user filters (P2-22)', () => {
  test('export → read carries the user filters', () => {
    const text = exportBackup(custom(), NOW, FILTERS);
    expect(JSON.parse(text)).toMatchObject({ version: 2, userFilters: FILTERS.hosts });
    expect(readBackup(text)).toEqual({ ok: true, value: { settings: backedUp(custom()), userFilters: FILTERS } });
  });

  test('a file saved under the earlier name (Stillpage) is still read', () => {
    const legacy = file(backedUp(custom()), { format: 'stillpage-backup', version: 2, userFilters: FILTERS.hosts });
    expect(readBackup(legacy)).toEqual({ ok: true, value: { settings: backedUp(custom()), userFilters: FILTERS } });
  });

  test('a version 1 file (P2-37) is still read; it carries no user filters, so a restore keeps them', () => {
    expect(readBackup(file(backedUp(custom())))).toEqual({ ok: true, value: { settings: backedUp(custom()), userFilters: null } });
  });

  test('a version 2 file without user filters is read as "keep the device’s"', () => {
    expect(readBackup(file(backedUp(custom()), { version: 2 }))).toMatchObject({ ok: true, value: { userFilters: null } });
  });

  test('an empty user filter record is a backup of "nothing hidden"', () => {
    expect(readBackup(exportBackup(custom(), NOW, { v: 1, hosts: {} }))).toMatchObject({ ok: true, value: { userFilters: { v: 1, hosts: {} } } });
  });
});

describe('backup file (P2-37)', () => {
  test('export → read is the identity on the backed-up fields', () => {
    const text = exportBackup(custom(), NOW);
    const read = readBackup(text);
    expect(read).toEqual({ ok: true, value: { settings: backedUp(custom()), userFilters: null } });
  });

  test('the export leaves out device-local state: pauses, onboarding, schema version', () => {
    const parsed = JSON.parse(exportBackup(custom(), NOW)) as { settings: Record<string, unknown> };
    expect(Object.keys(parsed.settings).sort()).toEqual(['cookieBanners', 'defaultLevel', 'gpc', 'packs', 'popups', 'siteLevels', 'ui']);
    expect(parsed).toMatchObject({ format: BACKUP_FORMAT, version: 2, exportedAt: NOW });
    expect(Object.keys(parsed)).not.toContain('userFilters');
  });

  test('restoring keeps local pauses and onboarding and replaces everything else', () => {
    const local: Settings = { ...createDefaultSettings(), pauses: { 'x.example': { until: NOW + 5 } } as Settings['pauses'], packs: { 'reg-it': true } as Settings['packs'] };
    const restored = withBackup(local, backedUp(custom()));
    expect(restored).toEqual({ ...custom(), pauses: local.pauses, onboarding: local.onboarding });
    expect(local.packs).toEqual({ 'reg-it': true });
  });

  test.each([
    ['empty text', '', 'not-json'],
    ['not JSON', '{nope', 'not-json'],
    ['JSON that is not an object', '[1,2]', 'not-backup'],
    ['another format', JSON.stringify({ format: 'ublock', version: 1 }), 'not-backup'],
    ['a newer version', file(backedUp(custom()), { version: 3 }), 'newer'],
    ['user filters in a version 1 file', file(backedUp(custom()), { userFilters: { 'a.example': ['#ad'] } }), 'invalid'],
    ['an unsafe user filter', file(backedUp(custom()), { version: 2, userFilters: { 'a.example': ['#ad{color:red}'] } }), 'invalid'],
    ['a user filter on a bad host', file(backedUp(custom()), { version: 2, userFilters: { 'javascript:x': ['#ad'] } }), 'invalid'],
    ['user filters that are not a record', file(backedUp(custom()), { version: 2, userFilters: ['#ad'] }), 'invalid'],
    ['a version that is not a number', file(backedUp(custom()), { version: '1' }), 'invalid'],
    ['an unknown top-level key', file(backedUp(custom()), { script: 'alert(1)' }), 'invalid'],
    ['an unknown settings key', file({ ...backedUp(custom()), extra: true }), 'invalid'],
    ['an unknown nested key', file({ ...backedUp(custom()), ui: { theme: 'dark', showBadge: true, css: 'x' } }), 'invalid'],
    ['a missing field', file({ ...backedUp(custom()), gpc: undefined }), 'invalid'],
    ['a bad hostname key', file({ ...backedUp(custom()), siteLevels: { 'javascript:alert(1)': 'off' } }), 'invalid'],
    ['a __proto__ key', `{"format":"${BACKUP_FORMAT}","version":1,"exportedAt":1,"settings":{"__proto__":{"x":1}}}`, 'invalid'],
    ['an off default level', file({ ...backedUp(custom()), defaultLevel: 'off' }), 'invalid'],
    ['a bad pack id', file({ ...backedUp(custom()), packs: { 'Not A Pack': true } }), 'invalid'],
    ['a negative export time', file(backedUp(custom()), { exportedAt: -1 }), 'invalid'],
  ])('refuses %s', (_name, text, problem) => {
    expect(readBackup(text)).toEqual({ ok: false, errors: problem });
  });

  test('a __proto__ site key is dropped by the schema, never assigned to a prototype', () => {
    const text = file({ ...backedUp(custom()), siteLevels: JSON.parse('{"__proto__":"off","a.example":"light"}') as object });
    const read = readBackup(text);
    if (!read.ok) throw new Error(read.errors);
    expect(Object.keys(read.value.settings.siteLevels)).toEqual(['a.example']);
    expect(Object.getPrototypeOf(read.value.settings.siteLevels)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['a.example']).toBeUndefined();
  });

  test('refuses a file over the size cap, counted in UTF-8 bytes', () => {
    const padding = 'é'.repeat(MAX_BACKUP_BYTES / 2 + 1);
    expect(readBackup(file(backedUp(custom()), { padding }))).toEqual({ ok: false, errors: 'too-large' });
  });

  test('refuses more sites than the per-level cap', () => {
    const siteLevels = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`s${String(i)}.example`, 'off']));
    expect(readBackup(file({ ...backedUp(custom()), siteLevels }))).toEqual({ ok: false, errors: 'invalid' });
  });

  test('refuses more than 64 pack entries (security review L1)', () => {
    const packs = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`pack-${String(i)}`, true]));
    expect(readBackup(file({ ...backedUp(custom()), packs }))).toEqual({ ok: false, errors: 'invalid' });
  });

  test('deeply nested JSON is refused, not a crash', () => {
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    expect(readBackup(deep).ok).toBe(false);
  });

  test('property: arbitrary text never throws and never yields a value outside the schema', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        const read = readBackup(text);
        if (read.ok) expect(Object.keys(read.value.settings).sort()).toHaveLength(7);
      }),
    );
  });

  test('property: any valid settings survive export and restore', () => {
    const level = fc.constantFrom<Settings['defaultLevel']>('light', 'standard', 'thorough');
    fc.assert(
      fc.property(level, fc.boolean(), fc.boolean(), fc.constantFrom<Settings['ui']['theme']>('system', 'light', 'dark'), (defaultLevel, gpc, showBadge, theme) => {
        const s: Settings = { ...custom(), defaultLevel, gpc, ui: { theme, showBadge } };
        const read = readBackup(exportBackup(s, NOW));
        if (!read.ok) throw new Error(read.errors);
        expect(withBackup(createDefaultSettings(), read.value.settings)).toEqual({ ...s, pauses: {}, onboarding: { completedAt: null } });
      }),
    );
  });
});
