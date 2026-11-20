/** Settings types (architecture notes §5.2). Private, durable state; lives in the vault, never in `storage.local`. */
import type { Hostname, PackId } from '../ids.js';

/** Current settings schema version. */
export const SETTINGS_SCHEMA_VERSION = 1;

/** Filtering levels, lowest first (ADR-015). */
export const LEVELS = ['off', 'light', 'standard', 'thorough'] as const;
export type Level = (typeof LEVELS)[number];
/** Levels a user may choose as the global default (Off is per site only). */
export type DefaultLevel = Exclude<Level, 'off'>;

/** Milliseconds since the Unix epoch. */
export type EpochMs = number;

export type PopupMode = 'off' | 'smart' | 'strict';
type SitePopupPolicy = 'allow' | 'strict';

interface PopupSettings {
  readonly mode: PopupMode;
  readonly sites: Readonly<Record<Hostname, SitePopupPolicy>>;
  /** Show the in-page "Pop-up blocked" notice. */
  readonly notice: boolean;
}

interface Pause {
  readonly until: EpochMs;
}

export interface Settings {
  readonly schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  readonly defaultLevel: DefaultLevel;
  readonly siteLevels: Readonly<Record<Hostname, Level>>;
  readonly pauses: Readonly<Record<Hostname, Pause>>;
  /** Explicit user choices only; a pack missing here takes its catalog default. */
  readonly packs: Readonly<Record<PackId, boolean>>;
  readonly cookieBanners: 'leave' | 'hide';
  readonly popups: PopupSettings;
  readonly gpc: boolean;
  readonly onboarding: { readonly completedAt: EpochMs | null };
  readonly ui: { readonly theme: 'system' | 'light' | 'dark'; readonly showBadge: boolean };
}

/** Outcome of reading stored settings. `wasReset` drives the visible "settings were reset" notice. */
export interface LoadedSettings {
  readonly settings: Settings;
  readonly wasReset: boolean;
  /**
   * The stored value has a newer schema than this build (after a downgrade). The settings are the
   * defaults, and the caller must not write them back over the stored value.
   */
  readonly isFromNewerVersion: boolean;
  /** Schema version the stored value was migrated from, or `null` when no migration ran. */
  readonly migratedFrom: number | null;
}
