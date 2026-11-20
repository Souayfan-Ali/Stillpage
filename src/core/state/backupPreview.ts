/**
 * The worker's preview answer (P2-37), validated by the page: the settings now, the settings a restore
 * would store, the packs left out and the digest the import must repeat (security review M2). Kept apart
 * from `backupPlan.ts` so the worker bundle carries only the planner.
 */
import * as v from 'valibot';
import { parseHostname } from '../hostname/validate.js';
import { parsePackId } from '../ids.js';
import { UserFilterHostsSchema } from '../userFilters/schema.js';
import { SettingsSchema } from './schema.js';

const MAX_DROPPED = 128;
/** Hosts of one `suffix` line: every site map's cap and more (P2-43). */
const MAX_DROPPED_HOSTS = 4_000;
const packId = v.pipe(
  v.string(),
  v.check((p) => parsePackId(p) === p, 'invalid pack id'),
);

const hostname = v.pipe(v.string(), v.check((h) => parseHostname(h) === h, 'invalid hostname'));

export const DroppedSchema = v.pipe(
  v.array(v.union([
    v.strictObject({ pack: packId, reason: v.picklist(['unavailable', 'not-toggleable', 'ruleset-slots', 'regex-pool', 'rule-pool', 'registrations', 'patterns']) }),
    /** Entries for a whole suffix a restore leaves out (P2-43 security review A-1, `backupHosts.ts`). */
    v.strictObject({ reason: v.literal('suffix'), hosts: v.pipe(v.array(hostname), v.minLength(1), v.maxLength(MAX_DROPPED_HOSTS)) }),
  ])),
  v.maxLength(MAX_DROPPED),
);

export const PreviewAnswerSchema = v.strictObject({
  before: SettingsSchema,
  after: SettingsSchema,
  dropped: DroppedSchema,
  /** User filters now and in the file (P2-22); `null` when the file carries none (they are kept). */
  filters: v.nullable(v.strictObject({ before: UserFilterHostsSchema, after: UserFilterHostsSchema })),
  digest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
});

export type Dropped = v.InferOutput<typeof DroppedSchema>[number];
