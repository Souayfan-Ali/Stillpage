/**
 * `diff` (P1-07): desired vs actual → the minimal plan. Items are matched by id and compared by
 * value (key order ignored), so an unchanged rule or registration is never re-sent.
 */
import type { RulesetId } from '../ids.js';
import type { ActualState, Plan, RuleUpdate } from './plan.js';
import type { DesiredState, DnrRule, ScriptRegistration } from './types.js';

/** JSON with object keys sorted, so equal values give equal strings. Array order is kept. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function byId<T, K>(items: readonly T[], key: (item: T) => K): ReadonlyMap<K, string> {
  return new Map(items.map((item) => [key(item), canonicalJson(item)]));
}

function diffRules(desired: readonly DnrRule[], actual: readonly DnrRule[]): RuleUpdate {
  const have = byId(actual, (r) => r.id);
  const want = byId(desired, (r) => r.id);
  const addRules = desired.filter((r) => have.get(r.id) !== want.get(r.id));
  const removeRuleIds = actual
    .filter((r) => !want.has(r.id) || want.get(r.id) !== have.get(r.id))
    .map((r) => r.id)
    .sort((a, b) => a - b);
  return { removeRuleIds, addRules };
}

function isSorted(list: readonly string[]): boolean {
  for (let i = 1; i < list.length; i += 1) if ((list[i - 1] ?? '') > (list[i] ?? '')) return false;
  return true;
}

/** The list itself when already sorted (ours always are), else a sorted copy: no sort on a no-op wake. */
const sortedCopy = (list: readonly string[]): readonly string[] => (isSorted(list) ? list : [...list].sort());

/**
 * Fixed-order key of a registration. Cheaper than `canonicalJson` at full scale (≈ 1,000 registrations,
 * ≈ 36,000 patterns compared on every wake); covers every field of `ScriptRegistration`. Patterns are
 * a set to Chrome, which returns them in its own order (P1-35: a reordered list was re-sent on every
 * wake), so they are compared sorted; `js` keeps its order (injection order).
 */
function registrationKey(r: ScriptRegistration): string {
  return JSON.stringify([r.id, r.world, r.js, sortedCopy(r.matches), sortedCopy(r.excludeMatches), r.runAt, r.allFrames, r.matchOriginAsFallback, r.persistAcrossSessions]);
}

function diffScripts(desired: readonly ScriptRegistration[], actual: readonly ScriptRegistration[]): Plan['scripts'] {
  const have = new Map(actual.map((r) => [r.id, registrationKey(r)]));
  const wanted = new Set(desired.map((r) => r.id));
  return {
    register: desired.filter((r) => !have.has(r.id)),
    update: desired.filter((r) => have.has(r.id) && have.get(r.id) !== registrationKey(r)),
    unregister: actual
      .filter((r) => !wanted.has(r.id))
      .map((r) => r.id)
      .sort(),
  };
}

function diffRulesets(desired: readonly RulesetId[], actual: readonly RulesetId[]): Plan['rulesets'] {
  return {
    enable: desired.filter((id) => !actual.includes(id)),
    disable: actual.filter((id) => !desired.includes(id)).sort(),
  };
}

/** The minimal plan from `actual` to `desired`. */
export function diff(desired: DesiredState, actual: ActualState): Plan {
  return {
    rulesets: diffRulesets(desired.enabledRulesets, actual.enabledRulesets),
    dynamicRules: diffRules(desired.dynamicRules, actual.dynamicRules),
    sessionRules: diffRules(desired.sessionRules, actual.sessionRules),
    scripts: diffScripts(desired.contentScripts, actual.contentScripts),
  };
}

/** True when the plan has nothing to do. */
export function isEmptyPlan(plan: Plan): boolean {
  return [
    plan.rulesets.enable,
    plan.rulesets.disable,
    plan.dynamicRules.removeRuleIds,
    plan.dynamicRules.addRules,
    plan.sessionRules.removeRuleIds,
    plan.sessionRules.addRules,
    plan.scripts.register,
    plan.scripts.update,
    plan.scripts.unregister,
  ].every((list) => list.length === 0);
}
