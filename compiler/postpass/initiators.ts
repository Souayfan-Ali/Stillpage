/**
 * Initiator merge (S-02b, ADR-011): rules identical except `initiatorDomains` — same action, priority,
 * bucket and every other condition key — become one rule with the union of their initiator domains.
 * `(init ∈ A ∧ rest) ∨ (init ∈ B ∧ rest) = init ∈ A ∪ B ∧ rest`, so verdicts are unchanged; request
 * hosts are never mixed, so attribution is unchanged. Equal priority is required because the
 * converter's priority depends on the number of `domain=` values.
 */
import type { DnrRule } from '../dnr/schema.js';
import { canonicalise, canonicalKey } from './canonical.js';
import type { BucketedRule } from './coalesce.js';

const withoutInitiators = (rule: DnrRule): DnrRule => ({
  ...rule,
  condition: Object.fromEntries(Object.entries(rule.condition).filter(([k]) => k !== 'initiatorDomains')),
});

/** Merges initiator-only differences; rules without `initiatorDomains` pass through unchanged. Pure. */
export function mergeInitiators(rules: readonly BucketedRule[]): readonly BucketedRule[] {
  const groups = new Map<string, { first: BucketedRule; domains: Set<string>; sources: Set<BucketedRule['sources'][number]> }>();
  const out: (BucketedRule | string)[] = [];
  for (const r of rules) {
    const domains = r.rule.condition.initiatorDomains;
    if (domains === undefined) {
      out.push(r);
      continue;
    }
    const key = `${canonicalKey(withoutInitiators(r.rule))}\u0000${r.bucket}`;
    const g = groups.get(key);
    if (g === undefined) {
      groups.set(key, { first: r, domains: new Set(domains), sources: new Set(r.sources) });
      out.push(key);
    } else {
      for (const d of domains) g.domains.add(d);
      for (const s of r.sources) g.sources.add(s);
    }
  }
  return out.map((item) => {
    if (typeof item !== 'string') return item;
    const g = groups.get(item);
    if (!g) throw new Error('initiator group lost');
    const rule = canonicalise({ ...g.first.rule, condition: { ...g.first.rule.condition, initiatorDomains: [...g.domains] } });
    return { rule, sources: [...g.sources], bucket: g.first.bucket };
  });
}
