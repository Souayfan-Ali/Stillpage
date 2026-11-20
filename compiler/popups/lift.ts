/**
 * The lifted pop-up destinations (D-55 / D-55a, ADR-011 amendment): `popup-lifted.json`, full release only.
 * A lifted host's redirect to blocked.html sits at 5,000,000, above the stock band, so it must change
 * only the page shown, never what is blocked. Lifted = a destination that a default non-malware ruleset
 * document-blocks unconditionally (block, `main_frame`, `requestDomains` or `||host^` and nothing else),
 * minus any host equal to, parent of or subdomain of a badware / urlhaus unconditional document-block
 * host, or one a malware `||prefix` filter without `^` can block by label prefix, minus any host a stock
 * `main_frame` allow could touch (its host, a parent, a TLD or a subdomain, whatever its path). A hostless
 * stock `main_frame` allow fails the build. Pure.
 */
import type { DnrRule } from '../dnr/schema.js';

/** Rulesets whose unconditional document blocks justify a lift (the default non-malware ones). */
export const LIFT_FROM = ['easylist', 'ubo', 'easyprivacy'] as const;
/** Rulesets whose document blocks a lifted host must never touch. */
const LIFT_MALWARE = ['badware', 'urlhaus'] as const;
/** The pop-up ruleset: neither justifies nor excludes. */
const POPUPS = 'popups';

/** Justifying ruleset id → sorted lifted hosts (only rulesets with at least one host). */
export type Lifted = Readonly<Record<string, readonly string[]>>;
export type RulesBySlot = ReadonlyMap<string, readonly DnrRule[]>;

export interface LiftSummary {
  readonly candidates: number;
  readonly lifted: number;
  readonly byRuleset: Readonly<Record<string, number>>;
  readonly excluded: { readonly malware: readonly string[]; readonly allow: readonly string[] };
}

/** Violations of a given file against given rulesets, by class (D-55a item 8a). */
export interface LiftViolations {
  readonly malware: readonly string[];
  readonly allow: readonly string[];
  readonly unjustified: readonly string[];
  /** `ruleset#id` of every stock `main_frame` allow without a host (budget 0). */
  readonly hostlessAllows: readonly string[];
}

const HOST_ONLY = /^\|\|([a-z0-9.-]+)\^?$/;
/** `||text` without `^`: a label-start prefix (`||promo-code-` blocks every `promo-code-*` host). */
const HOST_PREFIX_ONLY = /^\|\|([a-z0-9.-]+)$/;
const HOST_PREFIX = /^(?:\|\||\|https?:\/\/)([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?=[/^:?|]|$)/;
const UNCONDITIONAL_KEYS: ReadonlySet<string> = new Set(['requestDomains', 'resourceTypes', 'urlFilter']);
const onMainFrame = (r: DnrRule): boolean => (r.condition.resourceTypes ?? []).includes('main_frame');

/** Hosts a rule blocks as whole documents, whatever the URL, initiator or method; else none. */
function unconditionalHosts(r: DnrRule): readonly string[] {
  const c = r.condition;
  if (r.action.type !== 'block' || !onMainFrame(r) || Object.keys(c).some((k) => !UNCONDITIONAL_KEYS.has(k))) return [];
  if (c.urlFilter === undefined) return c.requestDomains ?? [];
  const host = c.requestDomains === undefined ? HOST_ONLY.exec(c.urlFilter)?.[1] : undefined;
  return host === undefined ? [] : [host];
}

/** Hosts a `main_frame` allow names (`requestDomains`, or the host its URL filter is anchored to); `null`: none. */
function allowHosts(r: DnrRule): readonly string[] | null {
  const c = r.condition;
  if (c.requestDomains !== undefined) return c.requestDomains;
  const host = c.urlFilter === undefined ? undefined : HOST_PREFIX.exec(c.urlFilter)?.[1];
  return host === undefined ? null : [host];
}

const isAllow = (r: DnrRule): boolean => (r.action.type === 'allow' || r.action.type === 'allowAllRequests') && onMainFrame(r);

const ancestors = (host: string): readonly string[] => host.split('.').map((_, i, parts) => parts.slice(i).join('.'));

/** A host set with "has a descendant" lookup: `touches(h)` = h, a parent of h or a subdomain of h is in it. */
function hostIndex(hosts: Iterable<string>): { readonly touches: (h: string) => boolean; readonly covers: (h: string) => boolean } {
  const set = new Set(hosts);
  const above = new Set([...set].flatMap((h) => ancestors(h).slice(1)));
  const covers = (h: string): boolean => ancestors(h).some((a) => set.has(a));
  return { covers, touches: (h) => covers(h) || above.has(h) };
}

const rulesOf = (rules: RulesBySlot, ids: readonly string[]): readonly DnrRule[] => ids.flatMap((id) => rules.get(id) ?? []);
const stockRules = (rules: RulesBySlot): readonly (readonly [string, DnrRule])[] =>
  [...rules].filter(([id]) => id !== POPUPS).flatMap(([id, list]) => list.map((r) => [id, r] as const));

interface Exclusions {
  readonly malware: (h: string) => boolean;
  readonly allow: (h: string) => boolean;
  readonly hostless: readonly string[];
}

/** Label-start prefixes of unconditional malware document blocks written without `^` (security review MEDIUM). */
const prefixesOf = (rules: readonly DnrRule[]): readonly string[] =>
  rules.filter((r) => unconditionalHosts(r).length > 0).flatMap((r) => HOST_PREFIX_ONLY.exec(r.condition.urlFilter ?? '')?.slice(1) ?? []);

/** Malware touches `h`: a host equal to, parent of or subdomain of it, or a prefix of one of its label starts. */
function malwareIndex(rules: readonly DnrRule[]): (h: string) => boolean {
  const hosts = hostIndex(rules.flatMap(unconditionalHosts));
  const prefixes = prefixesOf(rules);
  return (h) => hosts.touches(h) || ancestors(h).some((a) => prefixes.some((p) => a.startsWith(p)));
}

function exclusions(rules: RulesBySlot): Exclusions {
  const allows = stockRules(rules).filter(([, r]) => isAllow(r));
  const named = allows.map(([id, r]) => [id, r, allowHosts(r)] as const);
  return {
    malware: malwareIndex(rulesOf(rules, LIFT_MALWARE)),
    allow: hostIndex(named.flatMap(([, , hosts]) => hosts ?? [])).touches,
    hostless: named.filter(([, , hosts]) => hosts === null).map(([id, r]) => `${id}#${String(r.id)}`),
  };
}

/** Destinations each justifying ruleset document-blocks unconditionally. */
function justified(destinations: readonly string[], rules: RulesBySlot): ReadonlyMap<string, readonly string[]> {
  return new Map(LIFT_FROM.map((id) => {
    const blocked = hostIndex((rules.get(id) ?? []).flatMap(unconditionalHosts));
    return [id, destinations.filter((d) => blocked.covers(d))] as const;
  }));
}

/** The lifted file and its summary for the build log. Throws on a hostless stock `main_frame` allow. */
export function liftedDestinations(destinations: readonly string[], rules: RulesBySlot): { readonly lifted: Lifted; readonly summary: LiftSummary } {
  const ex = exclusions(rules);
  if (ex.hostless.length > 0) throw new Error(`hostless main_frame allow(s) (D-55a budget 0): ${ex.hostless.join(', ')}`);
  const byRuleset = justified([...new Set(destinations)].sort(), rules);
  const candidates = [...new Set([...byRuleset.values()].flat())].sort();
  const malware = candidates.filter(ex.malware);
  const allow = candidates.filter((h) => !ex.malware(h) && ex.allow(h));
  const keep = (h: string): boolean => !ex.malware(h) && !ex.allow(h);
  const lifted = Object.fromEntries([...byRuleset].map(([id, hosts]) => [id, hosts.filter(keep)] as const).filter(([, hosts]) => hosts.length > 0));
  return {
    lifted,
    summary: {
      candidates: candidates.length,
      lifted: new Set(Object.values(lifted).flat()).size,
      byRuleset: Object.fromEntries(Object.entries(lifted).map(([id, hosts]) => [id, hosts.length])),
      excluded: { malware, allow },
    },
  };
}

/** Every exclusion re-checked for `lifted` against `rules` (full release: hard; daily: drift report). */
export function liftViolations(lifted: Lifted, rules: RulesBySlot): LiftViolations {
  const ex = exclusions(rules);
  const hosts = [...new Set(Object.values(lifted).flat())].sort();
  const still = justified(hosts, rules);
  const isJustified = (h: string): boolean => Object.entries(lifted).some(([id, list]) => list.includes(h) && (still.get(id) ?? []).includes(h));
  return {
    malware: hosts.filter(ex.malware),
    allow: hosts.filter(ex.allow),
    unjustified: hosts.filter((h) => !isJustified(h)),
    hostlessAllows: ex.hostless,
  };
}

/** Hours until the full release a drift class requires (D-55a item 8d): malware 48 h, otherwise 7 days. */
export const LIFT_DRIFT_DEADLINE_HOURS = { malware: 48, other: 168 } as const;

/**
 * The daily ruleset-only job's drift report (D-55a items 8c–8d): the SHIPPED `popup-lifted.json` checked
 * against the new rulesets. A drift never blocks the daily; it requires a full release within the
 * deadline. Wiring into `rulesets.yml` is a separate release step.
 */
export interface LiftDriftReport {
  readonly schema: 1;
  readonly drift: boolean;
  readonly fullReleaseWithinHours: number | null;
  readonly violations: LiftViolations;
}

export function liftDriftReport(shipped: Lifted, rules: RulesBySlot): LiftDriftReport {
  const v = liftViolations(shipped, rules);
  const other = v.allow.length + v.unjustified.length + v.hostlessAllows.length > 0;
  const hours = v.malware.length > 0 ? LIFT_DRIFT_DEADLINE_HOURS.malware : other ? LIFT_DRIFT_DEADLINE_HOURS.other : null;
  return { schema: 1, drift: hours !== null, fullReleaseWithinHours: hours, violations: v };
}
