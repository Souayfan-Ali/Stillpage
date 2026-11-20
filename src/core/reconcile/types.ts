/**
 * Desired-state types (architecture notes §5.1). Plain data shaped like the Chrome API arguments, without
 * importing `chrome` types: core stays pure and testable in Node.
 */
import type { ScriptWorld } from '../catalog/registrations.js';
import type { PackId, RulesetId } from '../ids.js';

export type RuleActionType = 'block' | 'allow' | 'allowAllRequests' | 'upgradeScheme' | 'redirect' | 'modifyHeaders';
type ResourceType = 'main_frame' | 'sub_frame';

/** The subset of `chrome.declarativeNetRequest.Rule` that the worker creates. */
export interface DnrRule {
  readonly id: number;
  readonly priority: number;
  readonly action: { readonly type: RuleActionType; readonly redirect?: { readonly extensionPath?: string; readonly regexSubstitution?: string } };
  readonly condition: {
    readonly requestDomains?: readonly string[];
    readonly initiatorDomains?: readonly string[];
    readonly regexFilter?: string;
    /** Session rules only: the exact address of a lifted "Proceed once" (D-55a). */
    readonly urlFilter?: string;
    readonly isUrlFilterCaseSensitive?: boolean;
    readonly resourceTypes?: readonly ResourceType[];
    /** Session rules only ("Proceed once", P2-55). */
    readonly tabIds?: readonly number[];
  };
}

/** The subset of `chrome.scripting.RegisteredContentScript` that the worker registers. */
export interface ScriptRegistration {
  readonly id: string;
  readonly world: ScriptWorld;
  readonly js: readonly string[];
  readonly matches: readonly string[];
  readonly excludeMatches: readonly string[];
  /** `document_idle` only for the Thorough surveyor (P2-25). */
  readonly runAt: 'document_start' | 'document_idle';
  /** `true` for shards; `false` for the pop-up guard (top-level documents only, ADR-016). */
  readonly allFrames: boolean;
  readonly matchOriginAsFallback: true;
  readonly persistAcrossSessions: boolean;
}

/** Host permissions as returned by `permissions.getAll()`. */
export interface Grants {
  readonly origins: readonly string[];
}

/** Why an enabled pack was left out of the desired state. */
export type SkipReason = 'ruleset-slots' | 'regex-pool' | 'rule-pool' | 'registrations' | 'patterns';

export interface SkippedPack {
  readonly pack: PackId;
  readonly reason: SkipReason;
  /** What the pack would add on that measure (rule and regex counts are catalog ceilings). */
  readonly needed: number;
  /** What was left on that measure when the pack's turn came. */
  readonly available: number;
}

/**
 * The static rule pool as Chrome reports it (P2-26): `getAvailableStaticRuleCount()` and the rulesets
 * enabled now, whose rules that count already excludes.
 */
export interface RuleCapacity {
  readonly available: number;
  readonly enabled: readonly RulesetId[];
}

/** What Chrome should be configured to. Every list is sorted, so equal states compare equal. */
export interface DesiredState {
  readonly enabledRulesets: readonly RulesetId[];
  readonly dynamicRules: readonly DnrRule[];
  readonly sessionRules: readonly DnrRule[];
  readonly contentScripts: readonly ScriptRegistration[];
  /** Packs the user enabled that did not fit a limit; the UI says so (filter-pipeline notes §8). */
  readonly skippedPacks: readonly SkippedPack[];
  /** True when `<all_urls>` is granted, so host-access rules are installed (host-access gate). */
  readonly hasAllSitesAccess: boolean;
}
