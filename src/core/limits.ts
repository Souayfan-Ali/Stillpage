/**
 * Chrome limits and project budgets. Values here are the single source for code and tests.
 *
 * Chrome values: research notes 02 §1.2 with its erratum E-1 (regex pools measured by S-07).
 * Budgets: architecture notes §10, filter-pipeline notes §8, performance notes §2.3, frozen by the Phase 0 review (P0-27, D-01…D-17).
 * Per-ruleset rule and regex ceilings live in `lists/lists.config.json` and the catalog.
 */

/** Minimum Chrome version (Q-06, ADR-007): `topDomains` support. Lowering later is free. */
export const MIN_CHROME_VERSION = '145';

/** Closed integer range, both ends included. */
export interface IdRange {
  readonly min: number;
  readonly max: number;
}

// ── Chrome DNR limits ─────────────────────────────────────────────────────────────────────────

/** `GUARANTEED_MINIMUM_STATIC_RULES`: enabled static rules each extension is guaranteed. */
export const GUARANTEED_STATIC_RULES = 30_000;
/** Profile-wide static pool shared by all extensions on top of the guaranteed rules. */
export const GLOBAL_STATIC_RULE_POOL = 300_000;
/** `MAX_NUMBER_OF_STATIC_RULESETS`: rulesets that may be declared in the manifest. */
export const MAX_DECLARED_RULESETS = 100;
/** `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS`. */
export const MAX_ENABLED_RULESETS = 50;
/** `MAX_NUMBER_OF_DYNAMIC_RULES` (safe rules; unsafe ones count inside it). */
export const MAX_DYNAMIC_RULES = 30_000;
/** `MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES` (`redirect`, `modifyHeaders`). */
export const MAX_UNSAFE_DYNAMIC_RULES = 5_000;
/** `MAX_NUMBER_OF_SESSION_RULES`. */
export const MAX_SESSION_RULES = 5_000;
/** `MAX_NUMBER_OF_UNSAFE_SESSION_RULES`. */
export const MAX_UNSAFE_SESSION_RULES = 5_000;
/** Regex pool over all enabled static rulesets together (S-07, D-15). */
export const STATIC_REGEX_POOL = 1_000;
/** Regex pool shared by dynamic and session rules together (S-07, D-15). */
export const DYNAMIC_SESSION_REGEX_POOL = 1_000;
/** Compiled size limit of one regex rule (`kRegexMaxMemKb`), in bytes. */
export const REGEX_MAX_COMPILED_BYTES = 2_048;
/** `kMaxDisabledStaticRules`: individually disabled static rule ids. */
export const MAX_DISABLED_STATIC_RULES = 5_000;
/** `MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL` outside a user gesture. */
export const MAX_GET_MATCHED_RULES_CALLS = 20;
/** `GETMATCHEDRULES_QUOTA_INTERVAL`, in minutes. */
export const GET_MATCHED_RULES_INTERVAL_MINUTES = 10;
/** Lowest valid rule id and priority. */
export const MIN_RULE_ID = 1;
/** Highest priority the API accepts (2^31 − 1): accepted, NOT effective; never use it as a band bound. */
export const MAX_RULE_PRIORITY = 2_147_483_647;
/**
 * Highest priority Chromium honours: it matches on 24 bits, so 16,777,216 + x behaves like x
 * (measured 2026-11-14, Playwright 1.65 / chromium-1254, `testMatchOutcome` on dynamic
 * rules: 16,777,215 beats 5,000,000; 20,000,000 and 21,777,215 lose to it; 21,777,217 beats it). Every
 * band stays at or below this value (ADR-011 amendment).
 */
export const CHROME_EFFECTIVE_PRIORITY_MAX = 16_777_215;

// ── Our ruleset and file budgets ──────────────────────────────────────────────────────────────

/** Ruleset slots declared in v1.0 (D-16): 10 default, 2 cookies, 10 annoyances, params, GPC, 12 regional. */
export const RULESET_SLOTS = 36;
/** Largest ruleset file the compiler accepts (Chrome's own limit is ≈ 50 MiB, filter-pipeline notes §8). */
export const MAX_RULESET_FILE_BYTES = 10 * 1024 * 1024;
/** Default-on rule ceiling (D-07). */
export const DEFAULT_RULE_BUDGET = 24_000;
/** Default-on regex ceiling (D-07; 460 → 420 by P2-32 after D-34 freed 55 regex: the 40 went to `params-x`). */
export const DEFAULT_REGEX_BUDGET = 420;
/** Default + every non-regional pack must fit the guaranteed rules (filter-pipeline notes §8 design rule). */
export const NON_REGIONAL_RULE_BUDGET = 30_000;
/** Regex of default + every non-regional pack. */
export const NON_REGIONAL_REGEX_BUDGET = 485;

// ── Priority bands (S-07, ADR-011, D-10) ──────────────────────────────────────────────────────

/** Pop-up destination band, below every other stock rule (pop-up notes §6.1). */
export const POPUP_PRIORITY = { block: 1, redirect: 2, allow: 3 } as const;
/**
 * Lift band (D-55 / D-55a, ADR-011 amendment): the redirect of a lifted pop-up destination (one a default
 * non-malware ruleset already document-blocks) and its exact-URL "Proceed once". In the empty band above
 * the stock maximum and below user rules, so Off, pause, switches and user rules still win.
 */
export const POPUP_LIFT_PRIORITY = { redirect: 5_000_000, allow: 5_000_001 } as const;
/** Longest address a lifted "Proceed once" rule may name (D-55a item 2). */
export const PROCEED_ONCE_URL_MAX_CHARS = 2_048;
/** Added to the converter's priority for every stock rule, so the stock band starts at 10. */
export const STOCK_PRIORITY_SHIFT = 9;
/** Highest shifted stock priority; the compiler fails a build that reaches 2,000,000. */
export const STOCK_PRIORITY_MAX = 1_999_999;
/** Base of user rules (P3): 10,000,000 + rule priority. */
export const USER_PRIORITY_BASE = 10_000_000;
/** Highest priority a user rule may add to `USER_PRIORITY_BASE` (P3 validates, never clamps or wraps). */
export const USER_RULE_PRIORITY_MAX = 2_999_999;
/** Site switches (P3). */
export const SWITCH_PRIORITY = 14_000_000;
/** Off and pause (`allowAllRequests`); beats everything else. 15,000,001 … 16,777,215 is reserved. */
export const OFF_PRIORITY = 15_000_000;

// ── Attribution buckets (ADR-011, D-10) ───────────────────────────────────────────────────────

/** Companies in `lists/entities.json`. */
export const MAX_COMPANIES = 300;
/** Extra rules caused by attribution buckets over maximal coalescing, default set. */
export const MAX_BUCKET_OVERHEAD = 1_000;
/** Packaged `buckets.json`, gzip bytes (filter-pipeline notes §10). */
export const MAX_BUCKETS_GZIP_BYTES = 60_000;

// ── Dynamic and session id realms (architecture notes §10) ───────────────────────────────────────────────

/** Dynamic id realms. Ranges never overlap; `dynamicRealmOf` maps an id back to its realm. */
export const DYNAMIC_ID_REALMS = {
  hotfix: { min: 1, max: 99_999 },
  siteState: { min: 1_000_000, max: 1_000_099 },
  siteSwitches: { min: 1_100_000, max: 1_199_999 },
  popupDestinations: { min: 1_200_000, max: 1_200_099 },
  userRules: { min: 2_000_000, max: 2_999_999 },
  importedLists: { min: 3_000_000, max: 5_999_999 },
} as const satisfies Readonly<Record<string, IdRange>>;

/** Name of one dynamic id realm. */
export type DynamicRealm = keyof typeof DYNAMIC_ID_REALMS;

/** Session rule ids (picker previews, "Proceed once"). */
export const SESSION_ID_RANGE: IdRange = { min: 1, max: 4_999 };

/** True when `value` is an integer inside `range`. */
export function isInRange(value: number, range: IdRange): boolean {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

/** Returns the realm a dynamic rule id belongs to, or `null` for an id outside every realm. */
export function dynamicRealmOf(id: number): DynamicRealm | null {
  const realms = Object.keys(DYNAMIC_ID_REALMS) as DynamicRealm[];
  return realms.find((realm) => isInRange(id, DYNAMIC_ID_REALMS[realm])) ?? null;
}

// ── Content-script registrations (D-03, performance notes §2.3) ─────────────────────────────────────────

/** Match patterns over all registrations, default packs. */
export const DEFAULT_PATTERN_BUDGET = 40_000;
/**
 * Match patterns enabled together: default + every non-regional pack + the largest regional (P2-32,
 * design review 2026-11-14, replaces "every pack on ≤ 55,000", set before the cookie lists were compiled). Also
 * the runtime cap: a pack that would cross it is refused (P2-26). Each document pays ≈ 0.3–0.5 ms per
 * 1,000 patterns (P1-51), so the page budgets of performance notes §2.3/§2.5 hold for the default set only.
 */
export const ENABLED_PATTERN_BUDGET = 94_000;
/** Match patterns of the optional non-regional packs together (cookies, annoyances, params). */
export const OPTIONAL_NON_REGIONAL_PATTERN_BUDGET = 48_000;
/** Match patterns of one regional pack. */
export const REGIONAL_PACK_PATTERN_BUDGET = 6_000;
/** Registrations, all packs (2,048 → 2,560 by P2-32: 2,413 measured with every pack). */
export const REGISTRATION_BUDGET = 2_560;
/**
 * Patterns over the registrations that persist across sessions (P2-65, D-79e, S-23). Chrome re-processes them
 * on its UI thread on every registration call, at a cost growing with their square: 5,639 cost 56–69 ms a call,
 * 36,735 cost about 1.6 s. The rest is session-scoped (ADR-020).
 */
export const PERSISTENT_PATTERN_CAP = 6_000;
/** One inline data file (cosmetic or scriptlet shard), raw bytes (cosmetic notes §2.1, §6.3). */
export const MAX_SHARD_BYTES = 64 * 1024;
/**
 * Registrations of the default packs (D-23: 1,250 → 160 by D-41, P2-47): Chrome keeps each registration's
 * script text separately in shared memory mapped into the browser and every renderer, so fewer, larger
 * registrations; the rest of `REGISTRATION_BUDGET` is for optional packs.
 */
export const DEFAULT_REGISTRATION_BUDGET = 160;
/** Script bytes summed over the default registrations (each registration's files counted once each; D-41). */
export const REGISTERED_SCRIPT_BYTES_BUDGET = 10_000_000;
/**
 * Shard count per (pack, world, lane) is the smallest count ≤ `SHARD_COUNT` with a mean shard ≤ this
 * (D-23; 12 → 32 kB by D-41). MAIN shards and the ISOLATED code lane repeat code files, so they are sized
 * by the worst shard only.
 */
export const SHARD_TARGET_MEAN_BYTES = 32_000;
/** … and a worst shard ≤ this (48 → 56 kB by D-41; the hard gate stays `MAX_SHARD_BYTES`, 64 KiB). */
export const SHARD_TARGET_WORST_BYTES = 56_000;
/** Scriptlet dispatch data of the default packs, attributable bytes, one gzip stream (D-22). */
export const DISPATCH_BUDGET = { raw: 1_250_000, gzip: 360_000 } as const;
/** Scriptlet code summed over the default packs (D-22); per pack ≤ `SCRIPTLET_CODE_PACK_GZIP`. */
/** Raw line 250 → 260 kB by P1-37: the hardened MAIN/ISOLATED dispatcher adds ≈ 1.7 kB per code file; accepted in the Phase 1 review (D-27); gzip unchanged. */
export const SCRIPTLET_CODE_BUDGET = { raw: 260_000, gzip: 70_000 } as const;
export const SCRIPTLET_CODE_PACK_GZIP = 60_000;

// ── Input limits (architecture notes §7, ADR-015) ────────────────────────────────────────────────────────

/** Longest hostname (DNS, without the trailing dot). */
export const MAX_HOSTNAME_LENGTH = 253;
/** Longest DNS label. */
export const MAX_LABEL_LENGTH = 63;
/** Longest selector accepted from lists, users or backups. */
export const MAX_SELECTOR_LENGTH = 1_024;
/** Longest `:style()` declaration block (security notes §4). */
export const MAX_DECLARATION_LENGTH = 1_024;
/** Largest backup file accepted by `c/importBackup`, in bytes. */
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
/** Sites per level in v1 (ADR-015). */
export const MAX_SITES_PER_LEVEL = 1_000;
/** One pack's generic cosmetic data (`cosmetic/<pack>/generic.js`), raw: what a Thorough frame parses (P2-32; cookies 590 kB). */
export const GENERIC_PACK_MAX_BYTES = 650_000;
/** Cosmetic and scriptlet shards per pack (cosmetic notes §2.1, S-04). */
export const SHARD_COUNT = 256;
/** Shard cap per world for regional packs (P2-32): ≈ 19 hosts per shard at 256 was pure overhead. */
export const REGIONAL_SHARD_COUNT = 64;
/** Longest ruleset or pack id we mint (Chrome has no documented maximum). */
export const MAX_ID_LENGTH = 64;
