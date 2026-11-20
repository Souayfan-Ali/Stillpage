/**
 * Exact-duplicate removal within one ruleset (filter-pipeline notes §6.1). Cross-ruleset duplicates are kept so each
 * ruleset stays independently toggleable. The surviving rule keeps the first rule's id and the union
 * of the sources, so attribution (id map) loses nothing.
 */
import type { ConvertedRule } from '../convert/convert.js';
import { canonicalise, canonicalKey } from './canonical.js';

export interface DedupeResult {
  readonly rules: readonly ConvertedRule[];
  /** Rules dropped as duplicates of an earlier one. */
  readonly removed: number;
}

/** Canonicalises every rule and keeps one per canonical key, in first-seen order. Pure. */
export function dedupe(rules: readonly ConvertedRule[]): DedupeResult {
  const byKey = new Map<string, ConvertedRule>();
  for (const r of rules) {
    const key = canonicalKey(r.rule);
    const seen = byKey.get(key);
    byKey.set(key, seen ? { rule: seen.rule, sources: [...seen.sources, ...r.sources] } : { rule: canonicalise(r.rule), sources: r.sources });
  }
  return { rules: [...byKey.values()], removed: rules.length - byKey.size };
}
