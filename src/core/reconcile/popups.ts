/**
 * Pop-up protection in the desired state (P2-54; pop-up notes §6.2, §7.6; architecture notes §9–10; ADR-016 as amended).
 *
 * Registrations (top-level documents only, never dependent on grants, S-10):
 * - `popup-sentinel` (ISOLATED) + `popup-shim` (MAIN): `<all_urls>` in Smart and Strict; with the guard
 *   off (the v1.0 default, Q-21) only on Strict sites — the user's, plus the lists' when
 *   `listStrict` (design review, 2026-11-14). Under a Light default only subtrees raised to Standard or above.
 * - `popup-strict` (ISOLATED, a flag the sentinel reads): Strict sites; `<all_urls>` in Strict mode.
 * - `popup-quiet` (ISOLATED, a flag the sentinel reads, P2-59, design review): wherever the sentinel runs, only while
 *   the in-page notice is turned off ("Tell me when a pop-up is blocked").
 * - Off, Light and paused subtrees and "Allow pop-ups" sites are excluded from all three.
 *
 * Dynamic realm `popupDestinations`: `allow` (priority 3) for windows opened by Allow, Off or paused
 * sites, in every grant row; `redirect` (priority 2) of the packaged destinations to `blocked.html`,
 * only with `<all_urls>` (S-19) and only once the page ships. A second redirect group at 5,000,000 for
 * the lifted destinations (D-55 / D-55a): hosts a default non-malware ruleset already document-blocks,
 * lifted only while a justifying ruleset and `popups` are enabled; both groups share the unsafe budget.
 */
import { parentDomains } from '../hostname/walk.js';
import type { Hostname } from '../ids.js';
import { rootsAtOrAbove, rootsAtOrBelow } from '../levels/roots.js';
import { DYNAMIC_ID_REALMS, POPUP_LIFT_PRIORITY, POPUP_PRIORITY } from '../limits.js';
import type { EpochMs, Settings } from '../state/types.js';
import { hostPattern, toRegistration } from './registrations.js';
import type { DnrRule, ScriptRegistration } from './types.js';

/** Packaged guard scripts (WXT unlisted scripts, P2-57 / P2-58). */
export const POPUP_SCRIPTS = {
  sentinel: 'popup-sentinel.js',
  shim: 'popup-shim.js',
  strict: 'popup-strict.js',
  quiet: 'popup-quiet.js',
} as const;

/** architecture notes §10: safe / unsafe / regex rules of the pop-up destinations realm. */
export const POPUP_REALM_BUDGET = { safe: 20, unsafe: 20, regex: 20 } as const;

/** Fewest hosts per rule, so the rule count stays small for ordinary lists. */
const MIN_HOSTS_PER_RULE = 250;
/** `\0` is the whole URL: `blocked.html` reads it from the fragment as hostile input (P2-55). */
const ANY_WEB_URL = '^https?://.*';

/** What the worker reads from the package and its wiring for the pop-up part. */
export interface PopupInputs {
  /** `popup-destinations.json`: hosts redirected to the blocked page. */
  readonly destinations: readonly Hostname[];
  /** `popup-lifted.json` (D-55a): justifying ruleset id → destinations it document-blocks. */
  readonly lifted: Readonly<Record<string, readonly Hostname[]>>;
  /** `popup-strict-sites.json`: sites the lists designate as Strict. */
  readonly strictSites: readonly Hostname[];
  /** `chrome-extension://<id>/blocked.html`, or `null` while the page does not ship. */
  readonly blockedPageUrl: string | null;
  /** False while the guard scripts do not ship: no registration then. */
  readonly guardShipped: boolean;
  /** Whether list-designated Strict sites get the guard (`POPUP_LIST_STRICT_DEFAULT`). */
  readonly listStrict: boolean;
}

/** Drops every host with an ancestor in the list; sorted. */
function minimalRoots(hosts: readonly Hostname[]): readonly Hostname[] {
  const set = new Set(hosts);
  return [...set].filter((host) => !parentDomains(host).slice(1).some((parent) => set.has(parent))).sort();
}

const sitesWith = (settings: Settings, policy: 'allow' | 'strict'): readonly Hostname[] =>
  (Object.entries(settings.popups.sites) as [Hostname, string][]).filter(([, p]) => p === policy).map(([host]) => host);

/** Where the guard may run: the hosts given, or everywhere. */
type Target = 'everywhere' | readonly Hostname[];

interface Frame {
  readonly scope: 'everywhere' | readonly Hostname[];
  readonly excluded: readonly Hostname[];
}

/** One guard registration for `target` inside the level frame; `null` when no host is left. */
function registration(id: string, world: ScriptRegistration['world'], js: string, target: Target, frame: Frame): ScriptRegistration | null {
  if (target === 'everywhere' && frame.scope === 'everywhere') {
    const excludeMatches = frame.excluded.map(hostPattern).sort();
    return { id, world, js: [js], matches: ['<all_urls>'], excludeMatches, runAt: 'document_start', allFrames: false, matchOriginAsFallback: true, persistAcrossSessions: true };
  }
  // Light default: "everywhere" is the raised subtrees; listed hosts are narrowed to them.
  const [hosts, scope] = target === 'everywhere' ? [frame.scope as readonly Hostname[], 'everywhere' as const] : [target, frame.scope];
  const made = toRegistration({ id, world, js: [js], hosts }, scope, frame.excluded);
  return made === null ? null : { ...made, allFrames: false };
}

/** The guard registrations (they reserve registrations and patterns before the packs are chosen). */
export function popupRegistrations(settings: Settings, now: EpochMs, inputs: PopupInputs): readonly ScriptRegistration[] {
  if (!inputs.guardShipped) return [];
  const frame: Frame = {
    scope: settings.defaultLevel === 'light' ? rootsAtOrAbove(settings, now, 'standard') : 'everywhere',
    excluded: minimalRoots([...rootsAtOrBelow(settings, now, 'light'), ...sitesWith(settings, 'allow')]),
  };
  const strictSites = minimalRoots([...sitesWith(settings, 'strict'), ...(inputs.listStrict ? inputs.strictSites : [])]);
  const { mode } = settings.popups;
  const guard: Target = mode === 'off' ? strictSites : 'everywhere';
  const strict: Target = mode === 'strict' ? 'everywhere' : strictSites;
  const quiet: Target = settings.popups.notice ? [] : guard;
  const all = [
    guard.length === 0 ? null : registration('popup-sentinel', 'ISOLATED', POPUP_SCRIPTS.sentinel, guard, frame),
    guard.length === 0 ? null : registration('popup-shim', 'MAIN', POPUP_SCRIPTS.shim, guard, frame),
    strict.length === 0 ? null : registration('popup-strict', 'ISOLATED', POPUP_SCRIPTS.strict, strict, frame),
    quiet.length === 0 ? null : registration('popup-quiet', 'ISOLATED', POPUP_SCRIPTS.quiet, quiet, frame),
  ];
  return all.filter((r): r is ScriptRegistration => r !== null);
}

/** Sorted hosts in at most `maxRules` chunks of at least `MIN_HOSTS_PER_RULE`. */
function chunks(hosts: readonly Hostname[], maxRules: number): readonly (readonly Hostname[])[] {
  const size = Math.max(MIN_HOSTS_PER_RULE, Math.ceil(hosts.length / maxRules));
  return Array.from({ length: Math.ceil(hosts.length / size) }, (_, i) => hosts.slice(i * size, (i + 1) * size));
}

function allowRules(settings: Settings, now: EpochMs): readonly DnrRule[] {
  const openers = minimalRoots([...sitesWith(settings, 'allow'), ...rootsAtOrBelow(settings, now, 'off')]);
  return chunks(openers, POPUP_REALM_BUDGET.safe).map((initiatorDomains, i) => ({
    id: DYNAMIC_ID_REALMS.popupDestinations.min + i,
    priority: POPUP_PRIORITY.allow,
    action: { type: 'allow' },
    condition: { initiatorDomains, resourceTypes: ['main_frame'] },
  }));
}

/** The `popups` ruleset id: nothing is lifted while the pop-up pack is off (D-55a item 5). */
const POPUPS_RULESET = 'popups';
/** At most half the unsafe budget goes to the lifted group, so the ordinary group always has room. */
const LIFT_MAX_RULES = POPUP_REALM_BUDGET.unsafe / 2;

/** Destinations whose redirect is lifted now: a justifying ruleset and `popups` enabled, `<all_urls>`, page shipped. */
export function liftedHosts(inputs: PopupInputs, allSites: boolean, enabledRulesets: readonly string[]): ReadonlySet<Hostname> {
  const on = new Set(enabledRulesets);
  if (!allSites || inputs.blockedPageUrl === null || !on.has(POPUPS_RULESET)) return new Set();
  const listed = new Set(inputs.destinations);
  const hosts = Object.entries(inputs.lifted).filter(([id]) => on.has(id)).flatMap(([, list]) => list).filter((host) => listed.has(host));
  return new Set([...hosts].sort());
}

function redirectGroup(hosts: readonly Hostname[], page: string, priority: number, maxRules: number, firstId: number): readonly DnrRule[] {
  return chunks(hosts, maxRules).map((requestDomains, i) => ({
    id: firstId + i,
    priority,
    action: { type: 'redirect', redirect: { regexSubstitution: `${page}#\\0` } },
    condition: { regexFilter: ANY_WEB_URL, requestDomains, resourceTypes: ['main_frame'] },
  }));
}

function redirectRules(inputs: PopupInputs, allSites: boolean, lifted: ReadonlySet<Hostname>): readonly DnrRule[] {
  const page = inputs.blockedPageUrl;
  if (!allSites || page === null) return [];
  const firstId = DYNAMIC_ID_REALMS.popupDestinations.min + POPUP_REALM_BUDGET.safe;
  const high = redirectGroup([...lifted], page, POPUP_LIFT_PRIORITY.redirect, LIFT_MAX_RULES, firstId);
  const rest = [...new Set(inputs.destinations)].filter((host) => !lifted.has(host)).sort();
  return [...high, ...redirectGroup(rest, page, POPUP_PRIORITY.redirect, POPUP_REALM_BUDGET.unsafe - high.length, firstId + high.length)];
}

/** True when a live lifted redirect (5,000,000 in the pop-up realm) covers exactly `host` (D-55a). */
export function isLiftedLive(dynamicRules: readonly DnrRule[], host: string): boolean {
  const realm = DYNAMIC_ID_REALMS.popupDestinations;
  return dynamicRules.some((r) => r.id >= realm.min && r.id <= realm.max && r.priority === POPUP_LIFT_PRIORITY.redirect
    && r.action.type === 'redirect' && (r.condition.requestDomains ?? []).includes(host));
}

/** The realm rules for these settings, inputs, grant and enabled rulesets. */
export function popupRules(settings: Settings, now: EpochMs, inputs: PopupInputs, allSites: boolean, enabledRulesets: readonly string[]): readonly DnrRule[] {
  return [...allowRules(settings, now), ...redirectRules(inputs, allSites, liftedHosts(inputs, allSites, enabledRulesets))];
}
