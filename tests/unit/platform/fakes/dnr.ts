/**
 * In-memory `declarativeNetRequest` with the limits Chrome enforces (research notes 02 §1.2, S-07): the
 * static regex pool over the enabled set, the shared dynamic + session regex pool, unknown keys
 * rejected, unique ids, unsafe-rule quotas. Every failing call leaves the state unchanged.
 */
import type { RulesetId } from '../../../../src/core/ids.js';
import {
  DYNAMIC_SESSION_REGEX_POOL,
  GLOBAL_STATIC_RULE_POOL,
  GUARANTEED_STATIC_RULES,
  MAX_DISABLED_STATIC_RULES,
  MAX_DYNAMIC_RULES,
  MAX_ENABLED_RULESETS,
  MAX_SESSION_RULES,
  MAX_UNSAFE_DYNAMIC_RULES,
  MAX_UNSAFE_SESSION_RULES,
  STATIC_REGEX_POOL,
} from '../../../../src/core/limits.js';
import type { RuleUpdate } from '../../../../src/core/reconcile/plan.js';
import type { DnrRule } from '../../../../src/core/reconcile/types.js';
import type { DnrPort } from '../../../../src/platform/ports.js';
import { checkRules, copy, isRegex, isUnsafe } from './ruleChecks.js';

/** One `rule_resources` entry of the fake manifest. */
export interface FakeRuleset {
  readonly id: RulesetId;
  readonly enabled: boolean;
  readonly regexCount: number;
  /** Rules in the ruleset file (P2-26 rule pool); 0 when the test does not care. */
  readonly ruleCount?: number;
}

export interface FakeDnrLimits {
  readonly enabledRulesets: number;
  readonly staticRegex: number;
  readonly dynamicRules: number;
  readonly unsafeDynamicRules: number;
  readonly sessionRules: number;
  readonly unsafeSessionRules: number;
  readonly dynamicSessionRegex: number;
  readonly disabledStaticRules: number;
  /** Guaranteed rules + what other extensions left of the global pool. */
  readonly staticRules: number;
}

export const CHROME_DNR_LIMITS: FakeDnrLimits = {
  enabledRulesets: MAX_ENABLED_RULESETS,
  staticRegex: STATIC_REGEX_POOL,
  dynamicRules: MAX_DYNAMIC_RULES,
  unsafeDynamicRules: MAX_UNSAFE_DYNAMIC_RULES,
  sessionRules: MAX_SESSION_RULES,
  unsafeSessionRules: MAX_UNSAFE_SESSION_RULES,
  dynamicSessionRegex: DYNAMIC_SESSION_REGEX_POOL,
  disabledStaticRules: MAX_DISABLED_STATIC_RULES,
  staticRules: GUARANTEED_STATIC_RULES + GLOBAL_STATIC_RULE_POOL,
};

interface DnrState {
  readonly enabled: readonly RulesetId[];
  readonly disabled: Readonly<Record<string, readonly number[]>>;
  readonly dynamic: readonly DnrRule[];
  readonly session: readonly DnrRule[];
}

type Area = 'dynamic' | 'session';

export interface FakeDnr {
  readonly port: DnrPort;
  /** Update semantics: enabled rulesets back to the manifest, disabled ids cleared, rules kept. */
  readonly resetToManifest: () => void;
  /** Browser restart: session rules are gone, everything else is kept. */
  readonly endSession: () => void;
  /** What `getMatchedRules(tabId)` reports; `null` (the default) rejects like Chrome without an `activeTab` grant. */
  readonly setMatchedRules: (tabId: number, matches: readonly { rulesetId: string; ruleId: number }[] | null) => void;
}

const manifestEnabled = (rulesets: readonly FakeRuleset[]): RulesetId[] =>
  rulesets.filter((r) => r.enabled).map((r) => r.id).sort();

export function createFakeDnr(rulesets: readonly FakeRuleset[], limits: FakeDnrLimits): FakeDnr {
  const known = new Map(rulesets.map((r) => [r.id, r]));
  let state: DnrState = { enabled: manifestEnabled(rulesets), disabled: {}, dynamic: [], session: [] };

  const requireKnown = (id: RulesetId): void => {
    if (!known.has(id)) throw new Error(`Invalid ruleset id: ${id}.`);
  };

  const applyUpdate = (rules: readonly DnrRule[], update: RuleUpdate): DnrRule[] => {
    checkRules(update.addRules);
    const kept = rules.filter((r) => !update.removeRuleIds.includes(r.id));
    const next = [...kept, ...copy(update.addRules)];
    if (new Set(next.map((r) => r.id)).size !== next.length) throw new Error('Rule with id must have a unique ID.');
    return next.sort((a, b) => a.id - b.id);
  };

  const checkQuotas = (area: Area, next: readonly DnrRule[]): void => {
    const max = area === 'dynamic' ? limits.dynamicRules : limits.sessionRules;
    const maxUnsafe = area === 'dynamic' ? limits.unsafeDynamicRules : limits.unsafeSessionRules;
    if (next.length > max) throw new Error(`${area} rule count exceeded.`);
    if (next.filter(isUnsafe).length > maxUnsafe) throw new Error(`${area} rule count for unsafe rules exceeded.`);
    const other = area === 'dynamic' ? state.session : state.dynamic;
    if ([...next, ...other].filter(isRegex).length > limits.dynamicSessionRegex) {
      throw new Error(`${area} rule count for regex rules exceeded.`);
    }
  };

  const updateArea = (area: Area, update: RuleUpdate): Promise<void> => {
    const next = applyUpdate(state[area], update);
    checkQuotas(area, next);
    state = { ...state, [area]: next };
    return Promise.resolve();
  };

  const rulesOf = (ids: readonly RulesetId[]): number => ids.reduce((sum, id) => sum + (known.get(id)?.ruleCount ?? 0), 0);

  let matched = new Map<number, readonly { rulesetId: string; ruleId: number }[]>();
  const port: DnrPort = {
    getEnabledRulesets: () => Promise.resolve([...state.enabled]),
    getAvailableStaticRuleCount: () => Promise.resolve(Math.max(0, limits.staticRules - rulesOf(state.enabled))),
    updateEnabledRulesets: async (change) => {
      [...change.enable, ...change.disable].forEach(requireKnown);
      const next = [...new Set([...state.enabled.filter((id) => !change.disable.includes(id)), ...change.enable])].sort();
      const regex = next.reduce((sum, id) => sum + (known.get(id)?.regexCount ?? 0), 0);
      if (next.length > limits.enabledRulesets) throw new Error('The number of enabled static rulesets exceeds the limit.');
      if (regex > limits.staticRegex) {
        throw new Error('The set of enabled rulesets exceeds the regular expression rule count limit.');
      }
      if (rulesOf(next) > limits.staticRules) throw new Error('The set of enabled rulesets exceeds the static rule count limit.');
      state = { ...state, enabled: next };
      await Promise.resolve();
    },
    getDisabledRuleIds: async (rulesetId) => {
      requireKnown(rulesetId);
      await Promise.resolve();
      return [...(state.disabled[rulesetId] ?? [])];
    },
    updateStaticRules: async ({ rulesetId, disableRuleIds, enableRuleIds }) => {
      requireKnown(rulesetId);
      const current = state.disabled[rulesetId] ?? [];
      const next = [...new Set([...current, ...disableRuleIds])].filter((id) => !enableRuleIds.includes(id)).sort((a, b) => a - b);
      const total = Object.values({ ...state.disabled, [rulesetId]: next }).reduce((sum, ids) => sum + ids.length, 0);
      if (total > limits.disabledStaticRules) throw new Error('The number of disabled static rules exceeds the limit.');
      state = { ...state, disabled: { ...state.disabled, [rulesetId]: next } };
      await Promise.resolve();
    },
    getDynamicRules: () => Promise.resolve(copy(state.dynamic)),
    updateDynamicRules: (update) => updateArea('dynamic', update),
    getSessionRules: () => Promise.resolve(copy(state.session)),
    updateSessionRules: (update) => updateArea('session', update),
    getMatchedRules: (tabId) => {
      const found = matched.get(tabId);
      return found === undefined
        ? Promise.reject(new Error('The extension requires the "declarativeNetRequestFeedback" permission or "activeTab" granted for the tab.'))
        : Promise.resolve(copy(found));
    },
  };

  return {
    setMatchedRules: (tabId, matches) => {
      matched = new Map([...matched].filter(([id]) => id !== tabId));
      if (matches !== null) matched.set(tabId, copy(matches));
    },
    port,
    resetToManifest: () => {
      state = { ...state, enabled: manifestEnabled(rulesets), disabled: {} };
    },
    endSession: () => {
      state = { ...state, session: [] };
    },
  };
}
