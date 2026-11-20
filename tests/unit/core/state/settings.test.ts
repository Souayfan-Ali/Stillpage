import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { createDefaultSettings, POPUP_GUARD_DEFAULT } from '../../../../src/core/state/defaults.js';
import { loadSettings } from '../../../../src/core/state/load.js';
import { SETTINGS_SCHEMA_VERSION } from '../../../../src/core/state/types.js';

const NOW = 1_800_000_000_000;

/** A v0 settings sample: the shape of the pre-release draft (see src/core/state/migrate.ts). */
const V0_SAMPLE = {
  schemaVersion: 0,
  defaultLevel: 'thorough',
  siteLevels: { 'example.com': 'off', 'news.example.org': 'light' },
  pauses: { 'shop.example': 1_800_000_600_000 },
  packs: { cookies: true, ads: true },
  gpc: true,
  onboardingDone: true,
  theme: 'dark',
};

describe('createDefaultSettings', () => {
  test('starts at Standard with the pop-up guard opt-in (Q-21)', () => {
    const settings = createDefaultSettings();

    expect(settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(settings.defaultLevel).toBe('standard');
    expect(POPUP_GUARD_DEFAULT).toBe('off');
    expect(settings.popups.mode).toBe(POPUP_GUARD_DEFAULT);
    expect(settings.gpc).toBe(false);
    expect(settings.cookieBanners).toBe('leave');
    expect(settings.onboarding.completedAt).toBeNull();
  });

  test('returns a new, frozen object every call', () => {
    const a = createDefaultSettings();
    expect(a).not.toBe(createDefaultSettings());
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.popups)).toBe(true);
  });
});

describe('loadSettings: valid input', () => {
  test('keeps valid v1 settings unchanged', () => {
    const stored = {
      ...createDefaultSettings(),
      siteLevels: { 'example.com': 'off' },
      pauses: { 'a.example': { until: NOW + 1 } },
      packs: { cookies: true },
    };

    const result = loadSettings(stored, NOW);

    expect(result.wasReset).toBe(false);
    expect(result.migratedFrom).toBeNull();
    expect(result.settings).toEqual(stored);
  });

  test('round-trips its own output', () => {
    const once = loadSettings(createDefaultSettings(), NOW).settings;
    expect(loadSettings(JSON.parse(JSON.stringify(once)), NOW)).toEqual({
      settings: once,
      wasReset: false,
      migratedFrom: null,
      isFromNewerVersion: false,
    });
  });

  test('drops unknown keys instead of resetting', () => {
    const result = loadSettings({ ...createDefaultSettings(), legacy: 1 }, NOW);
    expect(result.wasReset).toBe(false);
    expect(result.settings).not.toHaveProperty('legacy');
  });
});

describe('loadSettings: invalid input falls back to defaults with wasReset', () => {
  test.each([
    ['nothing stored', undefined],
    ['null', null],
    ['a string', 'settings'],
    ['an array', []],
    ['a future schema', { ...createDefaultSettings(), schemaVersion: 99 }],
    ['an unknown level', { ...createDefaultSettings(), defaultLevel: 'max' }],
    ['default level off', { ...createDefaultSettings(), defaultLevel: 'off' }],
    ['an invalid hostname key', { ...createDefaultSettings(), siteLevels: { 'not a host': 'off' } }],
    ['a non-canonical hostname key', { ...createDefaultSettings(), siteLevels: { 'Example.com': 'off' } }],
    ['a bad pause', { ...createDefaultSettings(), pauses: { 'a.com': { until: -1 } } }],
    ['a bad pack id', { ...createDefaultSettings(), packs: { 'Bad Pack': true } }],
    ['a bad pop-up policy', { ...createDefaultSettings(), popups: { mode: 'off', sites: { 'a.com': 'smart' }, notice: true } }],
  ])('%s', (_name, input) => {
    const result = loadSettings(input, NOW);

    expect(result.wasReset).toBe(input !== undefined);
    expect(result.settings).toEqual(createDefaultSettings());
  });

  test('a newer schema resets in memory and says the stored value must not be overwritten', () => {
    const result = loadSettings({ ...createDefaultSettings(), schemaVersion: 2 }, NOW);

    expect(result).toMatchObject({ wasReset: true, isFromNewerVersion: true });
    expect(loadSettings({ schemaVersion: 'x' }, NOW).isFromNewerVersion).toBe(false);
  });

  test.each([
    ['pauses', (entries: Record<string, unknown>) => ({ ...createDefaultSettings(), pauses: entries })],
  ])('more than 1,000 %s', (_name, build) => {
    const entries = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`s${String(i)}.com`, { until: NOW }]));
    expect(loadSettings(build(entries), NOW).wasReset).toBe(true);
  });

  test('more than 1,000 pop-up site policies', () => {
    const sites = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`s${String(i)}.com`, 'allow']));
    const popups = { ...createDefaultSettings().popups, sites };
    expect(loadSettings({ ...createDefaultSettings(), popups }, NOW).wasReset).toBe(true);
  });

  test('more than 1,000 sites at one level', () => {
    const siteLevels = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`s${String(i)}.com`, 'light']));
    expect(loadSettings({ ...createDefaultSettings(), siteLevels }, NOW).wasReset).toBe(true);
  });

  test('never throws, whatever is stored', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = loadSettings(input, NOW);
        expect(typeof result.wasReset).toBe('boolean');
      }),
    );
  });
});

describe('migrations', () => {
  test('migrates the v0 sample to v1', () => {
    const result = loadSettings(V0_SAMPLE, NOW);

    expect(result.wasReset).toBe(false);
    expect(result.migratedFrom).toBe(0);
    expect(result.settings).toEqual({
      ...createDefaultSettings(),
      defaultLevel: 'thorough',
      siteLevels: { 'example.com': 'off', 'news.example.org': 'light' },
      pauses: { 'shop.example': { until: 1_800_000_600_000 } },
      packs: { cookies: true, ads: true },
      gpc: true,
      onboarding: { completedAt: NOW },
      ui: { theme: 'dark', showBadge: true },
    });
  });

  test('treats a v0 sample without onboarding as not onboarded', () => {
    const rest = Object.fromEntries(
      Object.entries(V0_SAMPLE).filter(([key]) => key !== 'onboardingDone' && key !== 'theme'),
    );
    const result = loadSettings(rest, NOW);

    expect(result.settings.onboarding.completedAt).toBeNull();
    expect(result.settings.ui.theme).toBe('system');
  });

  test('does not modify the stored object', () => {
    const stored = structuredClone(V0_SAMPLE);
    loadSettings(stored, NOW);
    expect(stored).toEqual(V0_SAMPLE);
  });

  test('P2-54: v0 gets the pop-up defaults (guard opt-in); a v0 value with a malformed popups object resets', () => {
    expect(loadSettings(V0_SAMPLE, NOW).settings.popups).toEqual({ mode: POPUP_GUARD_DEFAULT, sites: {}, notice: true });
    expect(POPUP_GUARD_DEFAULT).toBe('off');
    expect(loadSettings({ ...V0_SAMPLE, popups: { mode: 'always', sites: {}, notice: true } }, NOW)).toMatchObject({ wasReset: true, migratedFrom: 0 });
    expect(loadSettings({ ...V0_SAMPLE, popups: { mode: 'strict', sites: { 'a.com': 'allow' }, notice: false } }, NOW).settings.popups).toEqual({
      mode: 'strict',
      sites: { 'a.com': 'allow' },
      notice: false,
    });
  });

  test('resets a v0 sample that is broken after migration', () => {
    expect(loadSettings({ ...V0_SAMPLE, pauses: { 'a.com': 'soon' } }, NOW)).toMatchObject({
      wasReset: true,
      migratedFrom: 0,
    });
  });
});
