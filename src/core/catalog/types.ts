/**
 * Catalog types (filter-pipeline notes §9): the packaged description of what a build contains. Shared by the
 * compiler (which emits `catalog.json`) and the worker (whose `computeDesired` reads only this).
 * The catalog records ceilings, never per-build counts, so it can stay fixed across ruleset releases.
 */
import type { Hostname, PackId, RulesetId } from '../ids.js';
import type { CatalogRegistration } from './registrations.js';

/** Current catalog schema version. */
export const CATALOG_SCHEMA = 1;

/** `cleared`: licence evidence accepted. `owner-pending`: built, but kept out of public builds (D-16). */
export type LicenceState = 'cleared' | 'owner-pending';

/** One DNR ruleset slot. */
export interface CatalogRuleset {
  /** True exactly for `-x` rulesets: their rules (`redirect`, `modifyHeaders`) need `<all_urls>` (D-06). */
  readonly needsHostAccess: boolean;
  /** Rule ceiling (budget), not the build's count. */
  readonly maxRules: number;
  /** Regex ceiling (budget). */
  readonly maxRegex: number;
}

/** A user-facing pack: the unit users toggle (ADR-015). */
export interface CatalogPack {
  readonly rulesets: readonly RulesetId[];
  /** Enabled when the user has made no choice. */
  readonly default: boolean;
  readonly licence: LicenceState;
  /** Shard registration templates; optional in `catalog.json`, `[]` when absent (P1-06). */
  readonly registrations: readonly CatalogRegistration[];
  /** The pack ships `cosmetic/<pack>/generic.js` for the Thorough surveyor (P2-25). */
  readonly generic: boolean;
}

/** A pack without its host lists: what `catalog.json` alone says (the toolbar panel's read, P2-47 follow-up). */
export type CatalogPackSummary = Omit<CatalogPack, 'registrations'>;

/** The validated, frozen catalog. */
export interface Catalog {
  readonly schema: typeof CATALOG_SCHEMA;
  readonly rulesets: Readonly<Record<RulesetId, CatalogRuleset>>;
  readonly packs: Readonly<Record<PackId, CatalogPack>>;
  /**
   * `$generichide` hosts (P2-25), sorted: excluded from the `cosmetic-generic` registration. `null` when
   * the build carries none: then no generic registration is made at all (fail closed, design review).
   */
  readonly genericOff: readonly Hostname[] | null;
}
