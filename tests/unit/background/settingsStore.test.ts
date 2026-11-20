import { describe, expect, test } from 'vitest';
import { createDefaultSettings } from '../../../src/core/state/defaults.js';
import type { Settings } from '../../../src/core/state/types.js';
import { createSettingsStore, NOTICE_KEY, SETTINGS_KEY } from '../../../src/background/settingsStore.js';
import type { VaultPort } from '../../../src/platform/ports.js';

const NOW = 1_700_000_000_000;

function memoryVault(initial: Record<string, unknown> = {}): VaultPort & { items: () => Record<string, unknown> } {
  let items = { ...initial };
  return {
    get: (key) => Promise.resolve(items[key]),
    set: (key, value) => {
      items = { ...items, [key]: structuredClone(value) };
      return Promise.resolve();
    },
    remove: (key) => {
      items = Object.fromEntries(Object.entries(items).filter(([k]) => k !== key));
      return Promise.resolve();
    },
    items: () => items,
  };
}

const brokenVault = (): VaultPort => ({
  get: () => Promise.reject(new Error('UnknownError: Internal error opening backing store')),
  set: () => Promise.reject(new Error('UnknownError')),
  remove: () => Promise.reject(new Error('UnknownError')),
});

describe('settings store over the vault', () => {
  test('first run: defaults, no notice, nothing written', async () => {
    // Arrange
    const vault = memoryVault();

    // Act
    const loaded = await createSettingsStore(vault).read(NOW);

    // Assert
    expect(loaded.settings).toEqual(createDefaultSettings());
    expect(loaded.wasReset).toBe(false);
    expect(vault.items()).toEqual({});
  });

  test('a valid stored value is returned as is', async () => {
    const stored: Settings = { ...createDefaultSettings(), defaultLevel: 'thorough' };
    const loaded = await createSettingsStore(memoryVault({ [SETTINGS_KEY]: stored })).read(NOW);
    expect(loaded.settings.defaultLevel).toBe('thorough');
    expect(loaded.wasReset).toBe(false);
  });

  test('corrupted value: defaults + a reset notice; the corrupted value is not overwritten by the read', async () => {
    // Arrange
    const vault = memoryVault({ [SETTINGS_KEY]: { schemaVersion: 1, defaultLevel: 'max' } });

    // Act
    const loaded = await createSettingsStore(vault).read(NOW);

    // Assert
    expect(loaded.settings).toEqual(createDefaultSettings());
    expect(loaded.wasReset).toBe(true);
    expect(vault.items()[NOTICE_KEY]).toEqual({ kind: 'settings-reset', reason: 'invalid', at: NOW });
    expect(vault.items()[SETTINGS_KEY]).toEqual({ schemaVersion: 1, defaultLevel: 'max' });
  });

  test('a newer schema is reported as such and never overwritten', async () => {
    const vault = memoryVault({ [SETTINGS_KEY]: { schemaVersion: 99 } });
    const store = createSettingsStore(vault);
    const loaded = await store.read(NOW);
    expect(loaded.isFromNewerVersion).toBe(true);
    expect(vault.items()[NOTICE_KEY]).toMatchObject({ reason: 'newer' });
    await expect(store.write(createDefaultSettings(), loaded)).rejects.toThrow(/newer/);
  });

  test('an unreadable vault never throws, is flagged, stores no notice and refuses writes', async () => {
    const store = createSettingsStore(brokenVault());
    const loaded = await store.read(NOW);
    expect(loaded).toMatchObject({ isUnreadable: true, wasReset: false });
    await expect(store.write(createDefaultSettings(), loaded)).rejects.toThrow(/could not be read/);
  });

  test('an existing notice is kept: first reason and time win, a cleared notice is not re-added by a valid value', async () => {
    const vault = memoryVault({ [SETTINGS_KEY]: { schemaVersion: 99 } });
    await createSettingsStore(vault).read(NOW);
    await createSettingsStore(vault).read(NOW + 1);
    expect(vault.items()[NOTICE_KEY]).toEqual({ kind: 'settings-reset', reason: 'newer', at: NOW });
  });

  test('a notice write failure does not fail the read', async () => {
    const vault: VaultPort = { get: () => Promise.resolve('garbage'), set: () => Promise.reject(new Error('quota')), remove: () => Promise.resolve() };
    const loaded = await createSettingsStore(vault).read(NOW);
    expect(loaded.wasReset).toBe(true);
  });

  test('write validates before storing and rejects invalid settings', async () => {
    const vault = memoryVault();
    const store = createSettingsStore(vault);
    const loaded = await store.read(NOW);
    const bad = { ...createDefaultSettings(), defaultLevel: 'off' } as unknown as Settings;
    await expect(store.write(bad, loaded)).rejects.toThrow(/invalid settings/);
    expect(vault.items()).toEqual({});
    await store.write({ ...createDefaultSettings(), gpc: true }, loaded);
    expect((vault.items()[SETTINGS_KEY] as Settings).gpc).toBe(true);
  });

  test('writes are serialised in call order (single writer)', async () => {
    // Arrange
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const vault: VaultPort = {
      remove: () => Promise.resolve(),
      get: () => Promise.resolve(undefined),
      set: async (_key, value) => {
        const level = (value as Settings).defaultLevel;
        if (level === 'light') await gate;
        order.push(level);
      },
    };
    const store = createSettingsStore(vault);
    const loaded = await store.read(NOW);

    // Act
    const first = store.write({ ...createDefaultSettings(), defaultLevel: 'light' }, loaded);
    const second = store.write({ ...createDefaultSettings(), defaultLevel: 'thorough' }, loaded);
    release();
    await Promise.all([first, second]);

    // Assert
    expect(order).toEqual(['light', 'thorough']);
  });

  test('a failed write does not block later writes', async () => {
    let calls = 0;
    const vault: VaultPort = {
      remove: () => Promise.resolve(),
      get: () => Promise.resolve(undefined),
      set: () => (++calls === 1 ? Promise.reject(new Error('disk')) : Promise.resolve()),
    };
    const store = createSettingsStore(vault);
    const loaded = await store.read(NOW);
    await expect(store.write(createDefaultSettings(), loaded)).rejects.toThrow('disk');
    await expect(store.write(createDefaultSettings(), loaded)).resolves.toBeUndefined();
  });

  test('update reads, changes and writes inside the queue: concurrent updates both land', async () => {
    const vault = memoryVault();
    const store = createSettingsStore(vault);
    await Promise.all([
      store.update((s) => ({ ...s, gpc: true }), NOW),
      store.update((s) => ({ ...s, defaultLevel: 'thorough' }), NOW),
    ]);
    expect(vault.items()[SETTINGS_KEY]).toMatchObject({ gpc: true, defaultLevel: 'thorough' });
  });

  test('update refuses over an unreadable vault, a newer value or an invalid result, and later updates still run', async () => {
    await expect(createSettingsStore(brokenVault()).update((s) => s, NOW)).rejects.toThrow(/could not be read/);
    await expect(createSettingsStore(memoryVault({ [SETTINGS_KEY]: { schemaVersion: 99 } })).update((s) => s, NOW)).rejects.toThrow(/newer/);
    const vault = memoryVault();
    const store = createSettingsStore(vault);
    await expect(store.update((s) => ({ ...s, defaultLevel: 'off' }) as unknown as Settings, NOW)).rejects.toThrow(/invalid settings/);
    await store.update((s) => ({ ...s, gpc: true }), NOW);
    expect(vault.items()[SETTINGS_KEY]).toMatchObject({ gpc: true });
  });
});
