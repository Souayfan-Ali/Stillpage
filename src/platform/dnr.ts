/** `declarativeNetRequest` adapter (P1-10). Reads are projected onto our `DnrRule` shape. */
import type { RulesetId } from '../core/ids.js';
import type { DnrRule } from '../core/reconcile/types.js';
import type { DnrPort } from './ports.js';
import type { DnrApi } from './chromeApi.js';

type Loose = Readonly<Record<string, unknown>>;

const pick = (source: Loose, keys: readonly string[]): Loose =>
  Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));

/**
 * Keeps only the fields the worker sets, so a default Chrome adds on read (for example
 * `isUrlFilterCaseSensitive: false`) does not make every reconcile see a change.
 */
export function toDnrRule(raw: unknown): DnrRule {
  const rule = raw as Loose;
  const action = (rule['action'] ?? {}) as Loose;
  const redirect = action['redirect'] as Loose | undefined;
  const condition = (rule['condition'] ?? {}) as Loose;
  // `urlFilter` is set only by a lifted "Proceed once" (D-55a), always case-sensitive; Chrome's default `false` is dropped.
  const caseSensitive = condition['isUrlFilterCaseSensitive'] === true ? { isUrlFilterCaseSensitive: true } : {};
  return {
    ...pick(rule, ['id', 'priority']),
    action: { ...pick(action, ['type']), ...(redirect ? { redirect: pick(redirect, ['extensionPath', 'regexSubstitution']) } : {}) },
    condition: { ...pick(condition, ['requestDomains', 'initiatorDomains', 'regexFilter', 'urlFilter', 'resourceTypes', 'tabIds']), ...caseSensitive },
  } as unknown as DnrRule;
}

export function createDnrPort(api: DnrApi): DnrPort {
  return {
    getEnabledRulesets: async () => (await api.getEnabledRulesets()) as RulesetId[],
    getAvailableStaticRuleCount: () => api.getAvailableStaticRuleCount(),
    updateEnabledRulesets: ({ enable, disable }) =>
      api.updateEnabledRulesets({ enableRulesetIds: [...enable], disableRulesetIds: [...disable] }),
    getDisabledRuleIds: (rulesetId) => api.getDisabledRuleIds({ rulesetId }),
    updateStaticRules: ({ rulesetId, disableRuleIds, enableRuleIds }) =>
      api.updateStaticRules({ rulesetId, disableRuleIds: [...disableRuleIds], enableRuleIds: [...enableRuleIds] }),
    getDynamicRules: async () => (await api.getDynamicRules()).map(toDnrRule),
    updateDynamicRules: ({ removeRuleIds, addRules }) =>
      api.updateDynamicRules({ removeRuleIds: [...removeRuleIds], addRules: [...addRules] }),
    getSessionRules: async () => (await api.getSessionRules()).map(toDnrRule),
    updateSessionRules: ({ removeRuleIds, addRules }) =>
      api.updateSessionRules({ removeRuleIds: [...removeRuleIds], addRules: [...addRules] }),
    getMatchedRules: async (tabId) => (await api.getMatchedRules({ tabId })).rulesMatchedInfo.map(({ rule }) => ({ rulesetId: rule.rulesetId, ruleId: rule.ruleId })),
  };
}
