/**
 * The slices of `chrome.*` the adapters call, typed with our plain shapes. `chromePorts.ts` is the one
 * place that casts the real namespaces to these: Chrome's typings use enums where we use string
 * unions, and the wire values are identical. Tests pass hand-written stubs of the same shapes.
 */
import type { RuleUpdate } from '../core/reconcile/plan.js';
import type { DnrRule, ScriptRegistration } from '../core/reconcile/types.js';

export interface DnrApi {
  getEnabledRulesets(): Promise<string[]>;
  getAvailableStaticRuleCount(): Promise<number>;
  updateEnabledRulesets(options: { enableRulesetIds: string[]; disableRulesetIds: string[] }): Promise<void>;
  getDisabledRuleIds(options: { rulesetId: string }): Promise<number[]>;
  updateStaticRules(options: { rulesetId: string; disableRuleIds: number[]; enableRuleIds: number[] }): Promise<void>;
  getDynamicRules(): Promise<unknown[]>;
  updateDynamicRules(options: { removeRuleIds: number[]; addRules: DnrRule[] }): Promise<void>;
  getSessionRules(): Promise<unknown[]>;
  updateSessionRules(options: RuleUpdate & { removeRuleIds: number[]; addRules: DnrRule[] }): Promise<void>;
  getMatchedRules(filter: { tabId: number }): Promise<{ rulesMatchedInfo: { rule: { ruleId: number; rulesetId: string } }[] }>;
}

export interface ScriptingApi {
  getRegisteredContentScripts(): Promise<unknown[]>;
  registerContentScripts(scripts: ScriptRegistration[]): Promise<void>;
  updateContentScripts(scripts: ScriptRegistration[]): Promise<void>;
  unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
  insertCSS(injection: { target: { tabId: number; frameIds: number[] }; css: string; origin: 'USER' }): Promise<void>;
}

export interface PermissionsApi {
  contains(permissions: { origins: string[] }): Promise<boolean>;
  getAll(): Promise<{ origins?: string[] }>;
}

export interface StorageAreaApi {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface AlarmsApi {
  create(name: string, info: { when: number }): Promise<void>;
  clear(name: string): Promise<boolean>;
}

/** `chrome.tabs.get` only: no `tabs` permission (Chrome then fills `url` only with host access), no events. */
export interface TabsApi {
  get(tabId: number): Promise<{ url?: string; pendingUrl?: string }>;
}

export interface RuntimeApi {
  readonly id: string;
  getURL(path: string): string;
}
