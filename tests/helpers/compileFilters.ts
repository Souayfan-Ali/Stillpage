/**
 * Filter lines → DNR rules through the real compiler post-pass (classify → normalise → convert →
 * dedupe → priorities → buckets → safe/unsafe split), for test data written as filters (testing notes §3:
 * fixtures name the filters they exercise). Vitest-free, so the Playwright E2E helpers can use it too.
 */
import { convertRuleset } from '../../compiler/convert/convert.js';
import type { DnrRule } from '../../compiler/dnr/schema.js';
import { collectBadfilters } from '../../compiler/normalise/badfilter.js';
import { normaliseRuleset } from '../../compiler/normalise/normalise.js';
import { classify } from '../../compiler/parse/classify.js';
import { bucketRuleset } from '../../compiler/postpass/buckets.js';
import { dedupe } from '../../compiler/postpass/dedupe.js';
import { shiftStockPriorities } from '../../compiler/postpass/priorities.js';
import { splitSafeUnsafe, type SplitRuleset } from '../../compiler/postpass/split.js';

/** The safe and `-x` halves with the compiler's provenance (no entity map, one test list). */
export async function compileSplit(lines: readonly string[]): Promise<SplitRuleset> {
  const entries = lines.map((text, i) => ({ ...classify(text), source: { list: 'l', line: i + 1, text }, trusted: true }));
  const { rules } = await convertRuleset(normaliseRuleset(entries, collectBadfilters(entries)).inputs);
  return splitSafeUnsafe(bucketRuleset(shiftStockPriorities(dedupe(rules).rules), () => undefined, 'ads').rules);
}

export interface CompiledFilters {
  readonly safe: readonly DnrRule[];
  readonly unsafe: readonly DnrRule[];
}

/** Plain rules, renumbered from 1 in each half (the ledger's ids are not needed for a test ruleset). */
export async function compileFilters(lines: readonly string[]): Promise<CompiledFilters> {
  const { safe, unsafe } = await compileSplit(lines);
  const renumber = (half: SplitRuleset['safe']): DnrRule[] => half.map((b, i) => ({ ...b.rule, id: i + 1 }));
  return { safe: renumber(safe), unsafe: renumber(unsafe) };
}
