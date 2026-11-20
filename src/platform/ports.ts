/**
 * Adapter interfaces (P1-08, tooling notes §3). The worker talks to Chrome only through these ports, so the
 * reconciler runs in Node against in-memory fakes (`tests/unit/platform/fakes`) and in Chrome against
 * the thin wrappers next to this file. Shapes are core's plain data types; no `chrome` type leaks out.
 */
import type { Catalog, CatalogPackSummary } from '../core/catalog/types.js';
import type { Logger } from '../core/log.js';
import type { PackId, RulesetId } from '../core/ids.js';
import type { RuleUpdate } from '../core/reconcile/plan.js';
import type { DnrRule, Grants, ScriptRegistration } from '../core/reconcile/types.js';
import type { UserPorts } from './userPorts.js';

/** Static rule ids switched off inside one ruleset (`updateStaticRules`). */
export interface DisabledRules {
  readonly rulesetId: RulesetId;
  readonly ruleIds: readonly number[];
}

/** `chrome.declarativeNetRequest`. */
export interface DnrPort {
  getEnabledRulesets(): Promise<readonly RulesetId[]>;
  /** Static rules this extension may still enable (guaranteed + what is left of the global pool). */
  getAvailableStaticRuleCount(): Promise<number>;
  updateEnabledRulesets(change: { readonly enable: readonly RulesetId[]; readonly disable: readonly RulesetId[] }): Promise<void>;
  getDisabledRuleIds(rulesetId: RulesetId): Promise<readonly number[]>;
  updateStaticRules(change: {
    readonly rulesetId: RulesetId;
    readonly disableRuleIds: readonly number[];
    readonly enableRuleIds: readonly number[];
  }): Promise<void>;
  getDynamicRules(): Promise<readonly DnrRule[]>;
  updateDynamicRules(update: RuleUpdate): Promise<void>;
  getSessionRules(): Promise<readonly DnrRule[]>;
  updateSessionRules(update: RuleUpdate): Promise<void>;
  /**
   * Rules Chrome matched in one tab (P2-11). Needs `activeTab` granted for that tab (a toolbar click);
   * rejects otherwise. Rule ids only, never URLs.
   */
  getMatchedRules(tabId: number): Promise<readonly { readonly rulesetId: string; readonly ruleId: number }[]>;
}

/** `chrome.scripting` content-script registrations. One call is all-or-nothing in Chrome. */
export interface ScriptingPort {
  getRegisteredContentScripts(): Promise<readonly ScriptRegistration[]>;
  registerContentScripts(scripts: readonly ScriptRegistration[]): Promise<void>;
  updateContentScripts(scripts: readonly ScriptRegistration[]): Promise<void>;
  unregisterContentScripts(ids: readonly string[]): Promise<void>;
  /** USER-origin CSS into one frame (`cs/cssFallback`, P1-38). */
  insertCSS(details: CssInjection): Promise<void>;
}

export interface CssInjection {
  readonly target: { readonly tabId: number; readonly frameIds: readonly number[] };
  readonly css: string;
  readonly origin: 'USER';
}

/** Text of a file in our own package (P1-38: shard data for the CSS fallback). Rejects outside it. */
export interface PackagePort {
  readText(path: string): Promise<string>;
}

/** `chrome.storage.session` (trusted contexts only): reconcile flag, per-session notices. */
export interface SessionStorePort {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/** `chrome.permissions`, read side. */
export interface PermissionsPort {
  /** Grants with `<all_urls>` present exactly when `permissions.contains({origins:['<all_urls>']})`. */
  getGrants(): Promise<Grants>;
}

/** `chrome.alarms`: one-shot alarms by name. */
export interface AlarmsPort {
  /** Creates or replaces the alarm `name` to fire at `when` (epoch ms). */
  setAt(name: string, when: number): Promise<void>;
  clear(name: string): Promise<void>;
}

/** What Chrome tells us about one tab. `url` is `null` when Chrome withholds it (no host access). */
interface TabInfo {
  readonly url: string | null;
}

/**
 * `chrome.tabs.get` for a tab id an extension page named (P1-41). Needs no `tabs` permission; never
 * a tab event or query of other tabs (ADR-001/007/012). `null` when there is no such tab.
 */
export interface TabsPort {
  get(tabId: number): Promise<TabInfo | null>;
}

/** The private IndexedDB store (ADR-010, P1-09): extension origin only, never content-readable. */
export interface VaultPort {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  /** Deletes `key` (the settings-reset notice after `c/dismissNotice`, D-32). */
  remove(key: string): Promise<void>;
}

/** The packaged `catalog.json`, validated. Rejects when it is missing or invalid (fail closed). */
export interface CatalogPort {
  read(): Promise<Catalog>;
  /**
   * The packs as `catalog.json` alone describes them, without `registrations.json` (1.7 MB fetched,
   * hashed and validated by `read`): for answers that need no host list, such as the toolbar panel's.
   */
  readPacks(): Promise<Readonly<Record<PackId, CatalogPackSummary>>>;
}

/** The toolbar badge (P2-36) and the first-run tab (P2-33); optional so fakes may leave it out. */
export interface UiPort {
  /** `declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText })`. */
  showActionCount(enabled: boolean): Promise<void>;
  /** Opens `onboarding.html` in a new tab (`tabs.create` needs no permission). */
  openOnboarding(): Promise<void>;
}

/** Every port the worker needs. */
export interface Ports {
  readonly dnr: DnrPort;
  readonly scripting: ScriptingPort;
  readonly session: SessionStorePort;
  readonly permissions: PermissionsPort;
  readonly alarms: AlarmsPort;
  readonly vault: VaultPort;
  readonly catalog: CatalogPort;
  readonly package: PackagePort;
  readonly tabs: TabsPort;
  /** User filters, picker start, "Proceed once" (P2-20, P2-21, P2-55); absent in fakes that do not need them. */
  readonly user?: UserPorts;
  readonly log: Logger;
  readonly now: () => number;
  readonly ui?: UiPort;
}
