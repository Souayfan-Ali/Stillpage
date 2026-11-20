/**
 * Post-pass step 6.2 for one ruleset: bucketed coalescing, then the initiator merge, plus the bucket
 * overhead against maximal (single-bucket) coalescing. The overhead budget is ADR-011's: ≤ 1,000
 * extra rules over the default set with ≤ 300 companies (S-02b: + 596).
 */
import { MAX_BUCKET_OVERHEAD } from '../../src/core/limits.js';
import type { ConvertedRule } from '../convert/convert.js';
import { coalesce, type BucketedRule } from './coalesce.js';
import { mergeInitiators } from './initiators.js';


export interface BucketedRuleset {
  readonly rules: readonly BucketedRule[];
  /** Rule count with one bucket for everything (uBOL-style maximal coalescing). */
  readonly maximal: number;
}

/** `fallback` = `other:<category>`, used for hosts outside the entity map and rules without a host. */
export function bucketRuleset(rules: readonly ConvertedRule[], entityOf: (host: string) => string | undefined, category: string): BucketedRuleset {
  const fallback = `other:${category}`;
  const bucketed = mergeInitiators(coalesce(rules, (h) => entityOf(h) ?? fallback, fallback));
  const maximal = mergeInitiators(coalesce(rules, () => fallback, fallback)).length;
  return { rules: bucketed, maximal };
}

/** Extra rules caused by attribution buckets; throws above `MAX_BUCKET_OVERHEAD`. */
export function assertBucketOverhead(rulesets: readonly BucketedRuleset[], max = MAX_BUCKET_OVERHEAD): number {
  const overhead = rulesets.reduce((sum, r) => sum + r.rules.length - r.maximal, 0);
  if (overhead > max) throw new Error(`attribution buckets cost ${String(overhead)} extra rules (budget ${String(max)})`);
  return overhead;
}
