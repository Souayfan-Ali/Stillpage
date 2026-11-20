/**
 * Typed settings over the vault (P1-09, ADR-010, security notes §5). Reads never throw: anything wrong gives
 * the defaults and a stored "settings were reset" notice (never a silent reset). The read does not
 * write the defaults back, so a corrupted or newer value stays on disk until the user changes a
 * setting. The worker is the only writer; writes are validated and serialised in call order.
 */
import * as v from 'valibot';
import { createDefaultSettings } from '../core/state/defaults.js';
import { loadSettings } from '../core/state/load.js';
import { SettingsSchema } from '../core/state/schema.js';
import type { LoadedSettings, Settings } from '../core/state/types.js';
import type { Logger } from '../core/log.js';
import type { VaultPort } from '../platform/ports.js';

export const SETTINGS_KEY = 'settings';
export const NOTICE_KEY = 'notice';

type ResetReason = 'invalid' | 'newer';

/**
 * Shown by the toolbar panel / dashboard until the user dismisses it (`c/dismissNotice`, D-32). A
 * dismissed notice is kept with `dismissedAt`, so reading the still-damaged value does not raise it
 * again; it is deleted once valid settings are stored, so a later reset is shown afresh.
 */
interface ResetNotice {
  readonly kind: 'settings-reset';
  readonly reason: ResetReason;
  readonly at: number;
  readonly dismissedAt?: number;
}

const isNotice = (value: unknown): value is ResetNotice =>
  typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'settings-reset';

/** True when a stored notice value is waiting to be seen (present and not dismissed). */
export function isNoticeShown(value: unknown): boolean {
  return value !== undefined && !(isNotice(value) && value.dismissedAt !== undefined);
}

/** `c/dismissNotice` (D-32): marks the waiting notice as seen; nothing waiting is a no-op. */
export async function dismissNotice(vault: VaultPort, now: number): Promise<void> {
  const value = await vault.get(NOTICE_KEY);
  if (value === undefined) return;
  await (isNotice(value) ? vault.set(NOTICE_KEY, { ...value, dismissedAt: now }) : vault.remove(NOTICE_KEY));
}

/** After a valid write: a dismissed notice has done its job; a waiting one stays (never cleared silently). */
async function dropDismissedNotice(vault: VaultPort, log: Logger): Promise<void> {
  try {
    const value = await vault.get(NOTICE_KEY);
    if (value !== undefined && !isNoticeShown(value)) await vault.remove(NOTICE_KEY);
  } catch (error) {
    log.error('could not drop the dismissed notice', error);
  }
}

/** A read result. `isUnreadable`: the vault failed, the settings are only placeholders. */
interface StoredSettings extends LoadedSettings {
  readonly isUnreadable: boolean;
}

export interface SettingsStore {
  read(now: number): Promise<StoredSettings>;
  /**
   * Validates and stores `settings`; refuses to overwrite a value from a newer version, and refuses
   * after an unreadable read (a transient IndexedDB error must not replace the user's settings).
   */
  write(settings: Settings, loaded: StoredSettings): Promise<void>;
  /**
   * Read–change–write inside the write queue, so concurrent commands never lose each other's change
   * (closes the P1-09 review item sec M2c). Refuses like `write`.
   */
  update(change: (settings: Settings) => Settings, now: number): Promise<void>;
}

const SILENT: Logger = { warn: () => undefined, error: () => undefined };

async function readStored(vault: VaultPort, log: Logger): Promise<{ value: unknown } | null> {
  try {
    return { value: await vault.get(SETTINGS_KEY) };
  } catch (error) {
    log.error('vault read failed', error);
    return null;
  }
}

/** Stores the notice unless one is already waiting, so the first reason and time are kept. */
async function recordNotice(vault: VaultPort, notice: ResetNotice, log: Logger): Promise<void> {
  try {
    if ((await vault.get(NOTICE_KEY)) !== undefined) return;
    await vault.set(NOTICE_KEY, notice);
  } catch (error) {
    log.error('could not store the reset notice', error);
  }
}

/** Why `settings` must not be stored over what `loaded` read, or `null` when it may. */
function refusalOf(settings: Settings, loaded: StoredSettings): Error | null {
  if (loaded.isUnreadable) return new Error('the vault could not be read; not overwriting it');
  if (loaded.isFromNewerVersion) return new Error('stored settings are from a newer version');
  if (!v.safeParse(SettingsSchema, settings).success) return new Error('invalid settings');
  return null;
}

export function createSettingsStore(vault: VaultPort, log: Logger = SILENT): SettingsStore {
  let queue: Promise<void> = Promise.resolve();

  const read = async (now: number): Promise<StoredSettings> => {
    const stored = await readStored(vault, log);
    if (stored === null) {
      // No notice: the value on disk may be fine; the caller must not act on these placeholders.
      return { settings: createDefaultSettings(), wasReset: false, isFromNewerVersion: false, migratedFrom: null, isUnreadable: true };
    }
    const loaded: LoadedSettings =
      loadSettings(stored.value, now);
    if (loaded.wasReset) {
      const reason: ResetReason = loaded.isFromNewerVersion ? 'newer' : 'invalid';
      log.warn(`settings reset to defaults (${reason})`);
      await recordNotice(vault, { kind: 'settings-reset', reason, at: now }, log);
    }
    return { ...loaded, isUnreadable: false };
  };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = queue.then(task);
    queue = next.catch(() => undefined);
    return next;
  };

  const write = (settings: Settings, loaded: StoredSettings): Promise<void> => {
    const refusal = refusalOf(settings, loaded);
    return refusal === null ? enqueue(() => vault.set(SETTINGS_KEY, settings)) : Promise.reject(refusal);
  };

  const update = (change: (settings: Settings) => Settings, now: number): Promise<void> =>
    enqueue(async () => {
      const loaded = await read(now);
      const next = change(loaded.settings);
      const refusal = refusalOf(next, loaded);
      if (refusal !== null) throw refusal;
      await vault.set(SETTINGS_KEY, next);
      await dropDismissedNotice(vault, log);
    });

  return { read, write, update };
}
