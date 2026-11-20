/**
 * Post-pass step 6.4 (filter-pipeline notes §6.4, P1-22): safe rules (`block`, `allow`, `allowAllRequests`,
 * `upgradeScheme`) stay in `<id>.json`, `redirect` and `modifyHeaders` go to `<id>-x.json`.
 *
 * Invariant (S-19, D-06): every `-x` redirect to a packaged resource has a `block` in the safe half
 * that matches at least the same requests at a lower priority. The `-x` rulesets are off without
 * host access, so disabling them must never unblock a request. Transform redirects (`removeparam`,
 * `uritransform`) never blocked anything and are not covered.
 */
import { isSafeAction, type DnrCondition, type DnrRule } from '../dnr/schema.js';
import { canonicalKey } from './canonical.js';
import type { BucketedRule } from './coalesce.js';

export interface SplitRuleset {
  readonly safe: readonly BucketedRule[];
  readonly unsafe: readonly BucketedRule[];
}

const DEFAULT_PRIORITY = 1;
const HOST_ONLY = /^\|\|([a-z0-9._-]+)\^$/;

/** Splits one ruleset's rules by action. Order is kept within each half. Pure. */
export function splitSafeUnsafe(rules: readonly BucketedRule[]): SplitRuleset {
  return { safe: rules.filter((r) => isSafeAction(r.rule.action)), unsafe: rules.filter((r) => !isSafeAction(r.rule.action)) };
}

/** Throws when a safe file holds an unsafe action or a `-x` file a safe one. */
export function assertPurity(id: string, safe: readonly BucketedRule[], unsafe: readonly BucketedRule[]): void {
  const badSafe = safe.find((r) => !isSafeAction(r.rule.action));
  if (badSafe) throw new Error(`unsafe action ${badSafe.rule.action.type} in safe ruleset ${id}`);
  const badUnsafe = unsafe.find((r) => isSafeAction(r.rule.action));
  if (badUnsafe) throw new Error(`safe action ${badUnsafe.rule.action.type} in ${id}-x`);
}

interface Parts {
  /** Request hosts of a host-only rule; undefined when the rule has another URL condition. */
  readonly hosts: readonly string[] | undefined;
  readonly initiators: readonly string[] | undefined;
  /** Canonical key of everything else (action and priority removed). */
  readonly rest: string;
}

function partsOf(rule: DnrRule): Parts {
  const { urlFilter, requestDomains, initiatorDomains, ...rest } = rule.condition;
  // `||host^` alone is a host condition; any other URL pattern stays in `rest` and must match exactly.
  const patternHost = urlFilter === undefined || requestDomains !== undefined ? undefined : HOST_ONLY.exec(urlFilter)?.[1];
  const hosts = requestDomains ?? (patternHost === undefined ? undefined : [patternHost]);
  const condition: DnrCondition = urlFilter === undefined || patternHost !== undefined ? rest : { ...rest, urlFilter };
  const key = canonicalKey({ id: 1, action: { type: 'block' }, condition });
  return { hosts, initiators: initiatorDomains, rest: key };
}

const under = (h: string, domains: readonly string[]): boolean => domains.some((d) => h === d || h.endsWith(`.${d}`));

/** `outer` matches at least every request `inner` matches, for the parts that differ between rules. */
function covers(outer: Parts, inner: Parts): boolean {
  if (outer.rest !== inner.rest) return false;
  const hostsOk = outer.hosts === undefined || (inner.hosts?.every((h) => under(h, outer.hosts ?? [])) ?? false);
  const initOk = outer.initiators === undefined || (inner.initiators?.every((h) => under(h, outer.initiators ?? [])) ?? false);
  return hostsOk && initOk;
}

/** Redirects that stand in for a block: to a packaged resource or to another URL. */
const isResourceRedirect = (r: BucketedRule): boolean => r.rule.action.type === 'redirect'
  && (r.rule.action.redirect?.extensionPath !== undefined || r.rule.action.redirect?.url !== undefined);

/** Resource redirects in `unsafe` that no lower-priority `block` in `safe` covers. */
export function uncoveredRedirects(safe: readonly BucketedRule[], unsafe: readonly BucketedRule[]): readonly BucketedRule[] {
  const blocks = new Map<string, { parts: Parts; priority: number }[]>();
  for (const r of safe.filter((x) => x.rule.action.type === 'block')) {
    const parts = partsOf(r.rule);
    blocks.set(parts.rest, [...(blocks.get(parts.rest) ?? []), { parts, priority: r.rule.priority ?? DEFAULT_PRIORITY }]);
  }
  return unsafe.filter(isResourceRedirect).filter((r) => {
    const parts = partsOf(r.rule);
    const priority = r.rule.priority ?? DEFAULT_PRIORITY;
    return !(blocks.get(parts.rest) ?? []).some((b) => b.priority < priority && covers(b.parts, parts));
  });
}

/** Fails the build when a redirect has no covering block; names the source filters. */
export function assertRedirectsCovered(id: string, safe: readonly BucketedRule[], unsafe: readonly BucketedRule[]): void {
  const missing = uncoveredRedirects(safe, unsafe);
  if (missing.length === 0) return;
  const filters = missing.slice(0, 5).flatMap((r) => r.sources.map((s) => s.source.text));
  throw new Error(`${id}-x: ${String(missing.length)} redirect rule(s) without a covering block in ${id}: ${filters.join(' | ')}`);
}
