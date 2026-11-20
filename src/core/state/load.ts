/**
 * Reading stored settings (P1-02, security notes §5): migrate, validate, and on any failure fall back to
 * defaults with `wasReset` set, never a crash and never a silent reset. Nothing stored (first run)
 * is not a reset.
 */
import * as v from 'valibot';
import { createDefaultSettings } from './defaults.js';
import { migrate } from './migrate.js';
import { SettingsSchema } from './schema.js';
import { SETTINGS_SCHEMA_VERSION, type LoadedSettings, type Settings } from './types.js';

function reset(migratedFrom: number | null, isFromNewerVersion = false): LoadedSettings {
  return { settings: createDefaultSettings(), wasReset: true, migratedFrom, isFromNewerVersion };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Reads a stored settings value of any shape. `now` stamps migrated onboarding state. */
export function loadSettings(stored: unknown, now: number): LoadedSettings {
  if (stored === undefined) {
    return { settings: createDefaultSettings(), wasReset: false, migratedFrom: null, isFromNewerVersion: false };
  }
  const migrated = migrate(stored, now);
  if (migrated === 'newer') return reset(null, true);
  if (!migrated) return reset(null);
  const migratedFrom = migrated.from === SETTINGS_SCHEMA_VERSION ? null : migrated.from;
  const parsed = v.safeParse(SettingsSchema, migrated.raw);
  if (!parsed.success) return reset(migratedFrom);
  // Valibot builds new objects, so freezing the output never freezes the caller's value. The cast
  // attaches the Hostname / PackId brands: sound because HostKey and PackKey check every key.
  return { settings: deepFreeze(parsed.output as Settings), wasReset: false, migratedFrom, isFromNewerVersion: false };
}
