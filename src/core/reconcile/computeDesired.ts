/**
 * `computeDesired` (P1-06, architecture notes §5.1): settings × grants × catalog → the state Chrome should be
 * in. Pure: no `chrome.*`, no clock (the caller passes `now`), no mutation of inputs.
 */
import type { Catalog } from '../catalog/types.js';
import { rootsAtOrAbove, rootsAtOrBelow } from '../levels/roots.js';
import {
  ENABLED_PATTERN_BUDGET,
  MAX_ENABLED_RULESETS,
  PERSISTENT_PATTERN_CAP,
  REGISTRATION_BUDGET,
  STATIC_REGEX_POOL,
} from '../limits.js';
import type { PackId } from '../ids.js';
import type { EpochMs, Settings } from '../state/types.js';
import { applyHostAccessGate, hasAllSitesAccess } from './hostAccess.js';
import { selectPacks, type DesiredLimits } from './packs.js';
import { genericRegistration, genericScope } from './generic.js';
import { notifyGateRegistrations } from './notifyGate.js';
import { gpcRegistrations } from './gpc.js';
import { isPackEnabled } from './packChoice.js';
import { withPersistence } from './persistence.js';
import { liftedHosts, popupRegistrations, popupRules, type PopupInputs } from './popups.js';
import type { Scope } from './registrations.js';
import { siteStateRules } from './siteRules.js';
import { isLiftedProceedOnceRule, isProceedOnceRule, proceedOnceHost } from '../blocked/proceed.js';
import type { Hostname } from '../ids.js';
import { userCosmeticRegistration } from '../userFilters/registration.js';
import type { DesiredState, DnrRule, Grants, RuleCapacity } from './types.js';

export type { DesiredLimits } from './packs.js';

/** The Chrome limits and project budgets of `core/limits.ts`. */
export const DEFAULT_DESIRED_LIMITS: DesiredLimits = Object.freeze({
  enabledRulesets: MAX_ENABLED_RULESETS,
  staticRegex: STATIC_REGEX_POOL,
  registrations: REGISTRATION_BUDGET,
  patterns: ENABLED_PATTERN_BUDGET,
});

function scopeOf(settings: Settings, now: EpochMs): Scope {
  return settings.defaultLevel === 'light' ? rootsAtOrAbove(settings, now, 'standard') : 'everywhere';
}

/** Run-time facts read from Chrome by the caller (kept out of the pure inputs above). */
export interface DesiredContext {
  /** The static rule pool; absent when it could not be read (no rule check then). */
  readonly capacity?: RuleCapacity;
  /** Pop-up lists and wiring (P2-54); absent: no pop-up realm and no guard registration. */
  readonly popups?: PopupInputs;
  /** Hosts with user filters (P2-20): the `user-cosmetic` registration. */
  readonly userFilterHosts?: readonly Hostname[];
  /**
   * Session rules to keep (P2-55): only well-shaped "Proceed once" rules survive; the rest is removed. A
   * lifted (exact-URL) one survives only while its host is lifted (D-55a item 5).
   */
  readonly sessionRules?: readonly DnrRule[];
}

function userScripts(settings: Settings, now: EpochMs, context: DesiredContext) {
  const registration = userCosmeticRegistration(context.userFilterHosts ?? [], settings, now);
  return registration === null ? [] : [registration];
}

/** The limits left for packs after the fixed registrations (pop-up guard, GPC) took theirs (P2-32). */
function withoutFixed(limits: DesiredLimits, fixed: readonly { readonly matches: readonly string[] }[]): DesiredLimits {
  const patterns = fixed.reduce((n, r) => n + r.matches.length, 0);
  return { ...limits, registrations: limits.registrations - fixed.length, patterns: limits.patterns - patterns };
}

/** Packs that are on and fit, in catalog order. */
function selectedPacks(settings: Settings, catalog: Catalog, skipped: readonly { readonly pack: PackId }[]): readonly PackId[] {
  return (Object.keys(catalog.packs) as PackId[]).filter((id) => isPackEnabled(settings, id, catalog.packs[id]?.default === true) && !skipped.some((s) => s.pack === id));
}

/** Well-shaped Proceed once rules; a lifted one only while its host is still lifted. */
function keptSessionRules(context: DesiredContext, allSites: boolean, enabledRulesets: readonly string[]): readonly DnrRule[] {
  const lifted: ReadonlySet<string> = context.popups === undefined ? new Set() : liftedHosts(context.popups, allSites, enabledRulesets);
  return (context.sessionRules ?? []).filter((r) => isProceedOnceRule(r) && (!isLiftedProceedOnceRule(r) || lifted.has(proceedOnceHost(r) ?? '')));
}

/** Computes the desired state. Every list in the result is sorted. */
export function computeDesired(
  settings: Settings,
  grants: Grants,
  catalog: Catalog,
  now: EpochMs,
  limits: DesiredLimits = DEFAULT_DESIRED_LIMITS,
  context: DesiredContext = {},
): DesiredState {
  const allSites = hasAllSitesAccess(grants);
  const popupScripts = context.popups === undefined ? [] : popupRegistrations(settings, now, context.popups);
  const generic = genericScope(settings, catalog, now);
  const fixedNow = [...popupScripts, ...gpcRegistrations(settings, catalog, now)];
  const selection = selectPacks(settings, {
    catalog,
    allSites,
    scope: scopeOf(settings, now),
    lowered: rootsAtOrBelow(settings, now, 'light'),
    // The surveyor's one registration and its matches are reserved before the packs (P2-25).
    limits: withoutFixed(limits, [...fixedNow, ...(generic === null ? [] : [generic])]),
    capacity: context.capacity ?? null,
  });
  const packsOn = selectedPacks(settings, catalog, selection.skipped);
  const fixed = [...fixedNow, ...genericRegistration(generic, catalog, packsOn), ...notifyGateRegistrations(settings, now, packsOn)];
  const popups = context.popups === undefined ? [] : popupRules(settings, now, context.popups, allSites, selection.rulesets);
  return {
    enabledRulesets: [...selection.rulesets].sort(),
    dynamicRules: applyHostAccessGate([...siteStateRules(settings, now), ...popups], allSites),
    sessionRules: keptSessionRules(context, allSites, selection.rulesets),
    // P2-65 (D-79): only the capped core tier persists; the rest is restored by the startup reconcile.
    contentScripts: withPersistence([...selection.registrations, ...fixed, ...userScripts(settings, now, context)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), PERSISTENT_PATTERN_CAP),
    skippedPacks: selection.skipped,
    hasAllSitesAccess: allSites,
  };
}
