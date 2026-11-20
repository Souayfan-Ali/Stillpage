/**
 * Payloads of the settings pages' own messages (P2-33…P2-37), starting with the dashboard snapshot
 * (P2-34). Kept apart from `schemas.ts` (the worker spine) and spread into its table there; strict
 * objects like every payload.
 */
import * as v from 'valibot';
import { parseHostname } from '../hostname/validate.js';
import { MAX_SITES_PER_LEVEL } from '../limits.js';
import { BackupTextSchema } from '../state/backup.js';

const hostname = v.pipe(
  v.string(),
  v.check((h) => parseHostname(h) === h, 'invalid hostname'),
);

export const SETTINGS_PAGE_PAYLOAD_SCHEMAS = {
  'q/dashboard': v.strictObject({}),
  /** Clears level, pause and pop-up policy of each host in one settings write (design review: no loop of commands). */
  /** Backup preview (P2-37): the worker reads the file text from scratch, as `c/importBackup` does. */
  'q/previewBackup': v.strictObject({ json: BackupTextSchema }),
  /** Finish or skip on the first-run page (P2-33). */
  'c/completeOnboarding': v.strictObject({}),
  'c/setShowBadge': v.strictObject({ enabled: v.boolean() }),
  'c/forgetSites': v.strictObject({ hostnames: v.pipe(v.array(hostname), v.minLength(1), v.maxLength(MAX_SITES_PER_LEVEL)) }),
} as const;
