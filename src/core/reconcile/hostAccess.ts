/**
 * Host-access gate (architecture notes §8, ADR-007, D-06): rules whose action needs host access are installed
 * only while `<all_urls>` is granted. A per-site or "on click" grant is not enough: a redirect that
 * cannot apply lets the request through instead of falling back to the block (S-19).
 */
import type { DnrRule, Grants, RuleActionType } from './types.js';

const ALL_URLS = '<all_urls>';
const HOST_ACCESS_ACTIONS: ReadonlySet<RuleActionType> = new Set(['redirect', 'modifyHeaders']);

/** True only when the all-sites grant is present. */
export function hasAllSitesAccess(grants: Grants): boolean {
  return grants.origins.includes(ALL_URLS);
}

/** True for rules that need host access to apply. */
function needsHostAccess(rule: DnrRule): boolean {
  return HOST_ACCESS_ACTIONS.has(rule.action.type);
}

/** Drops host-access rules unless all-sites access is granted. Returns a new list. */
export function applyHostAccessGate(rules: readonly DnrRule[], allSites: boolean): readonly DnrRule[] {
  return allSites ? [...rules] : rules.filter((rule) => !needsHostAccess(rule));
}
