/**
 * Host coalescing per attribution bucket (filter-pipeline notes §6.2, ADR-011): host-only rules that share a
 * signature (everything but the request host) become one rule per (signature, bucket) with sorted
 * `requestDomains`; uBOL's hostname pruning drops a host whose parent is in the same list. Rules with
 * a path, a regex or anything else are not merged; they still get the bucket of their host.
 */
import type { ConvertedRule } from '../convert/convert.js';
import type { DnrCondition, DnrRule } from '../dnr/schema.js';
import { canonicalise, canonicalKey } from './canonical.js';

/** A rule with its attribution bucket: a company id, or `other:<category>`. */
export interface BucketedRule extends ConvertedRule {
  readonly bucket: string;
}

/** `host` → bucket. */
export type BucketOf = (host: string) => string;

const HOST_ONLY = /^\|\|([a-z0-9._-]+)\^$/;
const HOST_PREFIX = /^\|\|([a-z0-9._-]+)[/^:*]/;

interface HostShape {
  readonly hosts: readonly string[];
  readonly base: DnrRule;
}

/** The request hosts and the host-free remainder of a host-only rule; undefined for any other rule. */
function hostShape(rule: DnrRule): HostShape | undefined {
  const { urlFilter, requestDomains, ...rest } = rule.condition;
  if (rest.regexFilter !== undefined) return undefined;
  const base = { ...rule, condition: rest as DnrCondition };
  if (urlFilter !== undefined) {
    const m = HOST_ONLY.exec(urlFilter);
    return m?.[1] !== undefined && requestDomains === undefined ? { hosts: [m[1]], base } : undefined;
  }
  return requestDomains ? { hosts: requestDomains, base } : undefined;
}

/** uBOL's `pruneHostnameArray`: drop a host when one of its parents is in the same list; sorted. */
export function pruneHosts(hosts: readonly string[]): readonly string[] {
  const set = new Set(hosts);
  const covered = (h: string): boolean => {
    for (let i = h.indexOf('.'); i !== -1; i = h.indexOf('.', i + 1)) if (set.has(h.slice(i + 1))) return true;
    return false;
  };
  return [...set].filter((h) => !covered(h)).sort();
}

/** The bucket of a rule that is not coalesced: the bucket of its first request host, else the fallback. */
function bucketOfRule(rule: DnrRule, bucketOf: BucketOf, fallback: string): string {
  const host = rule.condition.requestDomains?.[0] ?? HOST_PREFIX.exec(`${rule.condition.urlFilter ?? ''}/`)?.[1];
  return host === undefined ? fallback : bucketOf(host);
}

interface Group {
  readonly base: DnrRule;
  readonly bucket: string;
  readonly hosts: string[];
  readonly sources: Set<ConvertedRule['sources'][number]>;
}

function mergedRule(g: Group): DnrRule {
  const hosts = pruneHosts(g.hosts);
  const [only] = hosts;
  const condition: DnrCondition = hosts.length === 1 && only !== undefined && g.base.condition.excludedRequestDomains === undefined
    ? { ...g.base.condition, urlFilter: `||${only}^` }
    : { ...g.base.condition, requestDomains: hosts };
  return canonicalise({ ...g.base, condition });
}

/** Coalesces `rules` (one ruleset); `fallback` is the bucket for rules without a host (`other:<category>`). */
export function coalesce(rules: readonly ConvertedRule[], bucketOf: BucketOf, fallback: string): readonly BucketedRule[] {
  const groups = new Map<string, Group>();
  const others: BucketedRule[] = [];
  for (const r of rules) {
    const shape = hostShape(r.rule);
    if (!shape) {
      others.push({ ...r, bucket: bucketOfRule(r.rule, bucketOf, fallback) });
      continue;
    }
    const signature = canonicalKey(shape.base);
    for (const host of shape.hosts) {
      const bucket = bucketOf(host);
      const key = `${signature}\u0000${bucket}`;
      const g = groups.get(key) ?? { base: shape.base, bucket, hosts: [], sources: new Set() };
      g.hosts.push(host);
      for (const s of r.sources) g.sources.add(s);
      groups.set(key, g);
    }
  }
  // Groups are local accumulators; what leaves this function is built fresh.
  const merged = [...groups.values()].map((g): BucketedRule => ({ rule: mergedRule(g), sources: [...g.sources], bucket: g.bucket }));
  return [...others, ...merged];
}
