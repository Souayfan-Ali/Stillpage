/** Plan and actual-state types (P1-07, architecture notes §5.1). */
import type { RulesetId } from '../ids.js';
import type { DnrRule, ScriptRegistration } from './types.js';

/** What Chrome currently has, as read back by the platform adapters (normalised to our shapes). */
export interface ActualState {
  readonly enabledRulesets: readonly RulesetId[];
  readonly dynamicRules: readonly DnrRule[];
  readonly sessionRules: readonly DnrRule[];
  readonly contentScripts: readonly ScriptRegistration[];
}

/** Arguments of one batched `updateDynamicRules` / `updateSessionRules` call. */
export interface RuleUpdate {
  readonly removeRuleIds: readonly number[];
  readonly addRules: readonly DnrRule[];
}

/**
 * The minimum set of Chrome calls that turns the actual state into the desired one. The reconciler
 * (P1-11) applies it in the order of architecture notes §5.1.
 */
export interface Plan {
  /** Arguments of `updateEnabledRulesets`. */
  readonly rulesets: { readonly enable: readonly RulesetId[]; readonly disable: readonly RulesetId[] };
  readonly dynamicRules: RuleUpdate;
  readonly sessionRules: RuleUpdate;
  readonly scripts: {
    readonly register: readonly ScriptRegistration[];
    readonly update: readonly ScriptRegistration[];
    readonly unregister: readonly string[];
  };
}
