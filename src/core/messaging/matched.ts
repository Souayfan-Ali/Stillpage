/**
 * The `q/matchedRules` answer (P2-11, UI notes §4): what Chrome's rule matcher reported for one tab,
 * counted per category and bucket through `buckets.json`. Rule ids only, never request URLs
 * (Chrome does not give them). Pure; the worker reads Chrome and the package, the panel validates
 * the answer with `MatchedRulesSchema`.
 *
 * Our own dynamic and session rules (`_dynamic`, `_session`) are not in `buckets.json`: the caller
 * classifies each one (`OwnRuleKind`): allow rules (Off, pause, pop-up openers, "Proceed once") are
 * dropped, redirects to the blocked page count as pop-ups, anything else as "Other" (design review, P2-11).
 */
import * as v from 'valibot';
import { ALLOW_BUCKET_ID, bucketOf, CATEGORIES, rulesetCategory, type BucketMap, type Category } from '../buckets/buckets.js';

/** Rules named in the answer (for the breakage report); the rest is a count. */
export const MAX_LISTED_RULES = 20;
/** Named companies listed per category; the rest is counted under "Other" (review HIGH: the schema caps rows). */
export const MAX_NAMED_ROWS = 50;
const MAX_ROWS = MAX_NAMED_ROWS + 1;
const MAX_COUNT = 1_000_000;
const OWN_RULESETS: ReadonlySet<string> = new Set(['_dynamic', '_session']);

export type OwnRuleKind = 'drop' | 'popup' | 'other';

export interface RuleMatch {
  readonly rulesetId: string;
  readonly ruleId: number;
}

const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_COUNT));
const RuleSchema = v.strictObject({
  rulesetId: v.pipe(v.string(), v.regex(/^(?:_dynamic|_session|[a-z0-9][a-z0-9-]{0,63})$/)),
  ruleId: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const MatchedRulesSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('counts'),
    /** The live call failed and this is the last answer for the same page. */
    stale: v.boolean(),
    at: v.pipe(v.number(), v.integer(), v.minValue(0)),
    total: count,
    groups: v.pipe(
      v.array(
        v.strictObject({
          category: v.picklist(CATEGORIES),
          count,
          /** `name: null` is "Other <category>". */
          buckets: v.pipe(v.array(v.strictObject({ id: v.pipe(v.string(), v.maxLength(64)), name: v.nullable(v.pipe(v.string(), v.maxLength(80))), count })), v.maxLength(MAX_ROWS)),
        }),
      ),
      v.maxLength(CATEGORIES.length),
    ),
    rules: v.pipe(v.array(RuleSchema), v.maxLength(MAX_LISTED_RULES)),
    moreRules: count,
  }),
  /** No grant for this tab (the panel was not opened from the toolbar) and nothing cached. */
  v.strictObject({ kind: v.literal('unavailable') }),
]);

export type MatchedRules = v.InferOutput<typeof MatchedRulesSchema>;
export type Counts = Extract<MatchedRules, { kind: 'counts' }>;
type Group = Counts['groups'][number];

interface Counted {
  readonly category: Category;
  readonly bucket: string;
}

function classify(map: BucketMap, match: RuleMatch, ownKind: (rulesetId: string, ruleId: number) => OwnRuleKind): Counted | null {
  if (!OWN_RULESETS.has(match.rulesetId)) {
    const bucket = bucketOf(map, match.rulesetId, match.ruleId);
    // A matched exception blocked nothing (the compiler marks it in buckets.json).
    return bucket === ALLOW_BUCKET_ID ? null : { category: rulesetCategory(map, match.rulesetId), bucket };
  }
  const kind = ownKind(match.rulesetId, match.ruleId);
  if (kind === 'drop') return null;
  return kind === 'popup' ? { category: 'popup', bucket: 'other:popup' } : { category: 'other', bucket: 'other:other' };
}

function tally<K>(keys: readonly K[], keyOf: (k: K) => string): Map<string, { readonly item: K; readonly n: number }> {
  const out = new Map<string, { readonly item: K; readonly n: number }>();
  for (const item of keys) {
    const key = keyOf(item);
    out.set(key, { item, n: (out.get(key)?.n ?? 0) + 1 });
  }
  return out;
}

function groupsOf(map: BucketMap, counted: readonly Counted[], hidden: ReadonlySet<string>): Group[] {
  const names = new Map(map.buckets.filter((b) => b.category === 'company').map((b) => [b.id, b.name]));
  const shown = counted.map((c) => (c.bucket.startsWith('other:') || !hidden.has(c.bucket) ? c : { ...c, bucket: `other:${c.category}` }));
  const perBucket = [...tally(shown, (c) => `${c.category}\n${c.bucket}`).values()];
  return CATEGORIES.flatMap((category): Group[] => {
    const all = perBucket
      .filter((r) => r.item.category === category)
      .map((r) => ({ id: r.item.bucket, name: r.item.bucket.startsWith('other:') ? null : (names.get(r.item.bucket) ?? null), count: r.n }));
    const total = all.reduce((sum, r) => sum + r.count, 0);
    return total === 0 ? [] : [{ category, count: total, buckets: capRows(category, all) }];
  });
}

/** Named rows by count (at most `MAX_NAMED_ROWS`), then one "Other" row with everything else. */
function capRows(category: Category, rows: readonly Group['buckets'][number][]): Group['buckets'] {
  const named = rows.filter((r) => r.name !== null).sort((a, b) => b.count - a.count || (a.name ?? '').localeCompare(b.name ?? ''));
  const kept = named.slice(0, MAX_NAMED_ROWS);
  const rest = rows.reduce((sum, r) => sum + r.count, 0) - kept.reduce((sum, r) => sum + r.count, 0);
  return rest === 0 ? kept : [...kept, { id: `other:${category}`, name: null, count: rest }];
}

function rulesOf(kept: readonly RuleMatch[]): { readonly rules: RuleMatch[]; readonly moreRules: number } {
  const distinct = [...tally(kept, (m) => `${m.rulesetId}#${String(m.ruleId)}`).values()].sort(
    (a, b) => b.n - a.n || a.item.rulesetId.localeCompare(b.item.rulesetId) || a.item.ruleId - b.item.ruleId,
  );
  const rules = distinct.slice(0, MAX_LISTED_RULES).map(({ item }) => ({ rulesetId: item.rulesetId, ruleId: item.ruleId }));
  return { rules, moreRules: distinct.length - rules.length };
}

/**
 * Counts `matches` (one entry per matched request). `hidden`: company buckets whose name is not shown
 * yet (owner review, D-34); they count under "Other" of their category.
 */
export function summariseMatches(
  map: BucketMap,
  matches: readonly RuleMatch[],
  ownKind: (rulesetId: string, ruleId: number) => OwnRuleKind,
  at: number,
  hidden: ReadonlySet<string> = new Set(),
): Counts {
  const pairs = matches.flatMap((match) => {
    const counted = classify(map, match, ownKind);
    return counted === null ? [] : [{ match, counted }];
  });
  const groups = groupsOf(
    map,
    pairs.map((p) => p.counted),
    hidden,
  );
  return { kind: 'counts', stale: false, at, total: pairs.length, groups, ...rulesOf(pairs.map((p) => p.match)) };
}
