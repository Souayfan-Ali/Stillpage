/**
 * Pure model of applying a plan, with Chrome's semantics (removals before additions in one rule
 * update; update replaces a registration by id). Used by property tests and the in-memory fakes;
 * the real reconciler calls Chrome instead.
 */
import type { ActualState, Plan, RuleUpdate } from './plan.js';
import type { DnrRule, ScriptRegistration } from './types.js';

function applyRules(rules: readonly DnrRule[], update: RuleUpdate): readonly DnrRule[] {
  const kept = rules.filter((r) => !update.removeRuleIds.includes(r.id));
  return [...kept, ...update.addRules].sort((a, b) => a.id - b.id);
}

function applyScripts(scripts: readonly ScriptRegistration[], plan: Plan['scripts']): readonly ScriptRegistration[] {
  const updated = scripts
    .filter((s) => !plan.unregister.includes(s.id))
    .map((s) => plan.update.find((u) => u.id === s.id) ?? s);
  return [...updated, ...plan.register].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The state after applying `plan` to `actual`. Returns new objects; `actual` is not touched. */
export function applyPlan(actual: ActualState, plan: Plan): ActualState {
  return {
    enabledRulesets: [
      ...actual.enabledRulesets.filter((id) => !plan.rulesets.disable.includes(id)),
      ...plan.rulesets.enable,
    ].sort(),
    dynamicRules: applyRules(actual.dynamicRules, plan.dynamicRules),
    sessionRules: applyRules(actual.sessionRules, plan.sessionRules),
    contentScripts: applyScripts(actual.contentScripts, plan.scripts),
  };
}
