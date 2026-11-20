/**
 * Chrome's checks on rules passed to `updateDynamicRules` / `updateSessionRules`, as measured in S-07:
 * unknown keys are rejected (static files ignore them), ids must be unique and ≥ 1. Priorities: Chrome
 * accepts 1 … 2^31 − 1 but matches on 24 bits; the fake is deliberately stricter and refuses anything
 * above `CHROME_EFFECTIVE_PRIORITY_MAX`, so an out-of-band rule fails in unit tests (D-55b).
 * Messages follow Chrome's wording closely enough for tests to match on.
 */
import { CHROME_EFFECTIVE_PRIORITY_MAX, MIN_RULE_ID } from '../../../../src/core/limits.js';
import type { DnrRule } from '../../../../src/core/reconcile/types.js';

const RULE_KEYS = new Set(['id', 'priority', 'action', 'condition']);
const ACTION_KEYS = new Set(['type', 'redirect', 'requestHeaders', 'responseHeaders']);
const CONDITION_KEYS = new Set([
  'domainType', 'domains', 'excludedDomains', 'excludedInitiatorDomains', 'excludedRequestDomains',
  'excludedRequestMethods', 'excludedResourceTypes', 'excludedResponseHeaders', 'excludedTabIds',
  'excludedTopDomains', 'initiatorDomains', 'isUrlFilterCaseSensitive', 'regexFilter', 'requestDomains',
  'requestMethods', 'resourceTypes', 'responseHeaders', 'tabIds', 'topDomains', 'urlFilter',
]);
const UNSAFE_ACTIONS = new Set(['redirect', 'modifyHeaders']);

function unknownKey(value: object, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key));
}

/** Throws like Chrome for the first invalid rule of `rules`. */
export function checkRules(rules: readonly DnrRule[]): void {
  for (const rule of rules) {
    const extra =
      unknownKey(rule, RULE_KEYS) ?? unknownKey(rule.condition, CONDITION_KEYS) ?? unknownKey(rule.action, ACTION_KEYS);
    if (extra !== undefined) throw new Error(`Unexpected property: '${extra}'.`);
    if (!Number.isInteger(rule.id) || rule.id < MIN_RULE_ID) throw new Error(`Rule with id ${String(rule.id)}: invalid id.`);
    if (!Number.isInteger(rule.priority) || rule.priority < 1 || rule.priority > CHROME_EFFECTIVE_PRIORITY_MAX) {
      throw new Error(`Rule with id ${String(rule.id)}: invalid priority (expected integer).`);
    }
  }
}

/** True for rules that count against the unsafe-rule quota. */
export function isUnsafe(rule: DnrRule): boolean {
  return UNSAFE_ACTIONS.has(rule.action.type);
}

/** True for regex rules (they count against the shared dynamic + session regex pool). */
export function isRegex(rule: DnrRule): boolean {
  return rule.condition.regexFilter !== undefined;
}

/** Copies a value so callers can never reach the fake's internal state. */
export function copy<T>(value: T): T {
  return structuredClone(value);
}
