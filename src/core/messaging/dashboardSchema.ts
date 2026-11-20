/**
 * Schemas of the dashboard (P2-34): `DashboardAnswerSchema` validates the worker's `q/dashboard` answer;
 * `DashboardSchema` is what the page draws, built from it by `describeDashboard` (`dashboard.ts`).
 */
import * as v from 'valibot';
import { parsePackId } from '../ids.js';
import { SettingsSchema } from '../state/schema.js';
import { UserFilterHostsSchema } from '../userFilters/schema.js';

const MAX_COUNT = 10_000_000;
const MAX_PACKS = 64;
const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_COUNT));
const packId = v.pipe(
  v.string(),
  v.check((p) => parsePackId(p) === p, 'invalid pack id'),
);

const SKIP_REASONS = ['ruleset-slots', 'regex-pool', 'rule-pool', 'registrations', 'patterns'] as const;

const PackRowSchema = v.strictObject({
  id: packId,
  /** On when the user has made no choice. */
  default: v.boolean(),
  /** On for these settings (explicit choice, or the default). */
  enabled: v.boolean(),
  /** False for packs that follow other settings (`popups`, `gpc`). */
  toggleable: v.boolean(),
  licence: v.picklist(['cleared', 'owner-pending']),
  /** Sum of the rule ceilings of the pack's rulesets. */
  ceiling: count,
  /** Why an enabled pack was left out by the last capacity check; `null` when it is in. */
  skipped: v.nullable(v.picklist(SKIP_REASONS)),
});

export const DashboardSchema = v.strictObject({
  settings: SettingsSchema,
  packs: v.pipe(v.array(PackRowSchema), v.maxLength(MAX_PACKS)),
  capacity: v.strictObject({
    guaranteed: count,
    /** Sum of the rule ceilings of the rulesets Chrome has enabled now. */
    usedCeiling: count,
    /** `getAvailableStaticRuleCount()`; `null` when Chrome could not tell. */
    available: v.nullable(count),
  }),
  allSites: v.boolean(),
  /** The heuristic pop-up guard is in this build (P2-57/58); until then only "Allow" per site has an effect (P2-60). */
  popupGuard: v.boolean(),
  /** The settings-reset notice is waiting (present and not dismissed, D-32). */
  settingsReset: v.boolean(),
  lastRun: v.picklist(['ok', 'failed', 'none']),
  /** The element hider's filters, one row per site sorted by host (P2-22); `null` when the store cannot be read. */
  hidden: v.nullable(v.pipe(v.array(v.strictObject({ host: v.string(), selectors: v.pipe(v.array(v.string()), v.readonly()) })), v.readonly())),
});

export type Dashboard = v.InferOutput<typeof DashboardSchema>;

const rulesetId = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,63}$/));

/**
 * What the worker answers to `q/dashboard` (D-47 placement rule: the worker reads and checks, the page
 * shapes for display): the settings, the catalog's packs with their rulesets and Chrome's numbers.
 * The page turns it into a `Dashboard` with `describeDashboard`.
 */
export const DashboardAnswerSchema = v.strictObject({
  settings: SettingsSchema,
  packs: v.pipe(
    v.array(
      v.strictObject({
        id: packId,
        default: v.boolean(),
        toggleable: v.boolean(),
        licence: v.picklist(['cleared', 'owner-pending']),
        rulesets: v.pipe(v.array(rulesetId), v.maxLength(MAX_PACKS)),
      }),
    ),
    v.maxLength(MAX_PACKS),
  ),
  /** Rule ceiling of every ruleset slot of the catalog. */
  ceilings: v.pipe(v.record(rulesetId, count), v.check((r) => Object.keys(r).length <= MAX_PACKS * 2, 'too many rulesets')),
  enabledRulesets: v.pipe(v.array(rulesetId), v.maxLength(MAX_PACKS * 2)),
  available: v.nullable(count),
  skipped: v.pipe(v.array(v.object({ pack: packId, reason: v.picklist(SKIP_REASONS) })), v.maxLength(MAX_PACKS)),
  allSites: v.boolean(),
  popupGuard: v.boolean(),
  settingsReset: v.boolean(),
  lastRun: v.picklist(['ok', 'failed', 'none']),
  /** The user filters per host (P2-22); `null` when the vault value cannot be read (it is then left alone). */
  userFilters: v.nullable(UserFilterHostsSchema),
});

export type DashboardAnswer = v.InferOutput<typeof DashboardAnswerSchema>;
export type PackRow = Dashboard['packs'][number];
