/**
 * Settings migrations (P1-02). Each step takes the raw object of version N and returns a new raw
 * object of version N + 1; the result is validated afterwards, so a step may pass bad values through.
 *
 * v0 is the pre-release draft shape: pauses as bare epoch numbers, `onboardingDone: boolean`,
 * `theme` at the top level, no `popups`, `cookieBanners` or `ui`. Nothing shipped with it; it exists
 * so the migration path is exercised before the first real schema change.
 */
import { createDefaultSettings } from './defaults.js';
import { SETTINGS_SCHEMA_VERSION } from './types.js';

type Raw = Readonly<Record<string, unknown>>;
type Step = (raw: Raw, now: number) => Raw;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function migratePausesV0(pauses: unknown): unknown {
  if (!isRecord(pauses)) return pauses;
  return Object.fromEntries(Object.entries(pauses).map(([host, until]) => [host, { until }]));
}

function v0ToV1(raw: Raw, now: number): Raw {
  const defaults = createDefaultSettings();
  const { onboardingDone, theme, ...rest } = raw;
  return {
    ...defaults,
    ...rest,
    schemaVersion: 1,
    pauses: migratePausesV0(rest['pauses'] ?? {}),
    onboarding: { completedAt: onboardingDone === true ? now : null },
    ui: { ...defaults.ui, theme: theme ?? defaults.ui.theme },
  };
}

/** `MIGRATIONS[n]` upgrades version n to n + 1. */
const MIGRATIONS: readonly Step[] = [v0ToV1];

/** Version of a raw stored value; a missing version means v0. */
function versionOf(raw: Raw): unknown {
  return raw['schemaVersion'] ?? 0;
}

/**
 * Upgrades `raw` to the current version. Returns the new raw value and the version it started from,
 * `'newer'` for a version above this build's, or `null` when the value or its version is malformed.
 */
export function migrate(raw: unknown, now: number): { readonly raw: Raw; readonly from: number } | 'newer' | null {
  if (!isRecord(raw)) return null;
  const from = versionOf(raw);
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) return null;
  if (from > SETTINGS_SCHEMA_VERSION) return 'newer';
  const upgraded = MIGRATIONS.slice(from).reduce<Raw>((value, step) => step(value, now), raw);
  return { raw: upgraded, from };
}
