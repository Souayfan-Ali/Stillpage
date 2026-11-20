/** Valibot schema for stored settings (P1-02). Unknown keys are dropped, wrong values fail. */
import * as v from 'valibot';
import { parsePackId } from '../ids.js';
import { parseHostname } from '../hostname/validate.js';
import { MAX_SITES_PER_LEVEL } from '../limits.js';
import { LEVELS, SETTINGS_SCHEMA_VERSION, type Level } from './types.js';

/** A key that is already a canonical hostname (no case or trailing-dot normalisation). */
const HostKey = v.pipe(
  v.string(),
  v.check((key) => parseHostname(key) === key, 'invalid hostname'),
);
const PackKey = v.pipe(
  v.string(),
  v.check((key) => parsePackId(key) !== null, 'invalid pack id'),
);
const epochMs = v.pipe(v.number(), v.integer(), v.minValue(0));

/** At most `MAX_SITES_PER_LEVEL` entries: keeps every derived rule inside its id realm. */
function capped<T>(record: Readonly<Record<string, T>>): boolean {
  return Object.keys(record).length <= MAX_SITES_PER_LEVEL;
}

function withinSiteCap(levels: Readonly<Record<string, Level>>): boolean {
  const values = Object.values(levels);
  return LEVELS.every((level) => values.filter((value) => value === level).length <= MAX_SITES_PER_LEVEL);
}

export const SettingsSchema = v.object({
  schemaVersion: v.literal(SETTINGS_SCHEMA_VERSION),
  defaultLevel: v.picklist(['light', 'standard', 'thorough']),
  siteLevels: v.pipe(
    v.record(HostKey, v.picklist(LEVELS)),
    v.check(withinSiteCap, `more than ${String(MAX_SITES_PER_LEVEL)} sites at one level`),
  ),
  pauses: v.pipe(v.record(HostKey, v.object({ until: epochMs })), v.check(capped, 'too many pauses')),
  packs: v.record(PackKey, v.boolean()),
  cookieBanners: v.picklist(['leave', 'hide']),
  popups: v.object({
    mode: v.picklist(['off', 'smart', 'strict']),
    sites: v.pipe(v.record(HostKey, v.picklist(['allow', 'strict'])), v.check(capped, 'too many sites')),
    notice: v.boolean(),
  }),
  gpc: v.boolean(),
  onboarding: v.object({ completedAt: v.nullable(epochMs) }),
  ui: v.object({ theme: v.picklist(['system', 'light', 'dark']), showBadge: v.boolean() }),
});
