/**
 * Settings backup file (P2-37, security notes T12, design review 2026-11-14). A backup is hostile input: it is read
 * with a byte cap, parsed as JSON in a `try`, then validated by strict schemas (any unknown key, at any
 * level, refuses the whole file). Only portable choices are written: pauses and onboarding state are
 * device-local and kept from the device on restore. A restore replaces the backed-up fields wholesale
 * (a merge could not be previewed honestly). Version 2 (P2-22) adds the user's element-hider filters
 * (`userFilters`, optional): absent, as in every version 1 file, means "keep the device's". Pure.
 */
import * as v from 'valibot';
import { PRODUCT_SLUG } from '../brand.js';
import { MAX_BACKUP_BYTES } from '../limits.js';
import type { Result } from '../result.js';
import { UserFilterHostsSchema } from '../userFilters/schema.js';
import type { UserFilters } from '../userFilters/store.js';
import { SettingsSchema } from './schema.js';
import type { Settings } from './types.js';

export const BACKUP_FORMAT = `${PRODUCT_SLUG}-backup`;
/** Format written before the rename to Glassmere; still read so older backup files restore. */
const LEGACY_BACKUP_FORMAT = 'stillpage-backup';
const isBackupFormat = (format: unknown): boolean => format === BACKUP_FORMAT || format === LEGACY_BACKUP_FORMAT;
/** Version of the file format (not the settings schema): 2 adds the user filters (P2-22); 1 is still read. */
const BACKUP_VERSION = 2;

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** The text of a backup as messages carry it: at most `MAX_BACKUP_BYTES` UTF-8 bytes. */
export const BackupTextSchema = v.pipe(
  v.string(),
  v.maxLength(MAX_BACKUP_BYTES),
  v.check((s) => utf8Bytes(s) <= MAX_BACKUP_BYTES, 'backup too large'),
);

const fields = SettingsSchema.entries;
/** More than any build has (36 rulesets); the preview's list of dropped packs stays short. */
const MAX_BACKUP_PACKS = 64;

const BackupSettingsSchema = v.strictObject({
  defaultLevel: fields.defaultLevel,
  siteLevels: fields.siteLevels,
  /** Capped like the site records: a preview lists every dropped pack (security review L1). */
  packs: v.pipe(fields.packs, v.check((packs) => Object.keys(packs).length <= MAX_BACKUP_PACKS, 'too many packs')),
  cookieBanners: fields.cookieBanners,
  popups: v.strictObject(fields.popups.entries),
  gpc: fields.gpc,
  ui: v.strictObject(fields.ui.entries),
});

const header = {
  format: v.picklist([BACKUP_FORMAT, LEGACY_BACKUP_FORMAT]),
  exportedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  settings: BackupSettingsSchema,
};

const BackupFileSchema = v.variant('version', [
  v.strictObject({ ...header, version: v.literal(1) }),
  v.strictObject({ ...header, version: v.literal(BACKUP_VERSION), userFilters: v.optional(UserFilterHostsSchema) }),
]);

export type BackupSettings = Pick<Settings, 'defaultLevel' | 'siteLevels' | 'packs' | 'cookieBanners' | 'popups' | 'gpc' | 'ui'>;

/** A backup as read: the settings, and the user filters (`null`: the file has none, keep the device's). */
export interface Backup {
  readonly settings: BackupSettings;
  readonly userFilters: UserFilters | null;
}

/** Why a file was refused; the page words each one. */
export type BackupProblem = 'too-large' | 'not-json' | 'not-backup' | 'newer' | 'invalid';

/** The backed-up part of `settings`. */
function portable(settings: Settings): BackupSettings {
  const { defaultLevel, siteLevels, packs, cookieBanners, popups, gpc, ui } = settings;
  return { defaultLevel, siteLevels, packs, cookieBanners, popups, gpc, ui };
}

/** The backup file's text for `settings` and, when known, the user filters; stamped `now`. */
export function exportBackup(settings: Settings, now: number, userFilters: UserFilters | null = null): string {
  const filters = userFilters === null ? {} : { userFilters: userFilters.hosts };
  return JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now, settings: portable(settings), ...filters }, null, 2);
}

function parseJson(text: string): { readonly value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

function headerProblem(value: unknown): BackupProblem | null {
  if (!isRecord(value) || !isBackupFormat(value['format'])) return 'not-backup';
  const version = value['version'];
  return typeof version === 'number' && version > BACKUP_VERSION ? 'newer' : null;
}

/** Reads a backup file's text. Never throws. */
export function readBackup(text: string): Result<Backup, BackupProblem> {
  if (!v.safeParse(BackupTextSchema, text).success) return { ok: false, errors: 'too-large' };
  const json = parseJson(text);
  if (json === null) return { ok: false, errors: 'not-json' };
  const problem = headerProblem(json.value);
  if (problem !== null) return { ok: false, errors: problem };
  const parsed = v.safeParse(BackupFileSchema, json.value);
  if (!parsed.success) return { ok: false, errors: 'invalid' };
  const { settings } = parsed.output;
  const hosts = parsed.output.version === 1 ? undefined : parsed.output.userFilters;
  const userFilters: UserFilters | null = hosts === undefined ? null : { v: 1, hosts };
  return { ok: true, value: { settings, userFilters } };
}

/** `settings` with the backed-up fields replaced by `backup`; pauses and onboarding stay. New object. */
export function withBackup(settings: Settings, backup: BackupSettings): Settings {
  return { ...settings, ...portable({ ...settings, ...backup }) };
}
