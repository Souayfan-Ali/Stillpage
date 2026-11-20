/**
 * The packaged `buckets.json` (filter-pipeline notes §10, ADR-011), read by the worker for `q/matchedRules` (P2-11).
 * Per ruleset, runs `[firstId, bucketIndex]` of consecutive rule ids, closed by `[maxId + 1, -1]`
 * (`compiler/emit/buckets.ts`). An id outside every run — minted by a later ruleset release, or of a
 * ruleset the file does not list — is "Other" of its ruleset's category.
 *
 * Company buckets carry category `company`; the category of a ruleset (ads, tracking, malware,
 * pop-up) is taken from the one `other:<category>` fallback bucket in its own runs, which the
 * compiler assigns from the list's category (design review, P2-11: no compiler change; owner follow-up to
 * carry it explicitly). A ruleset with none, or with two, is `other`. Exception rules carry the
 * reserved index -2 and resolve to `ALLOW_BUCKET_ID`: they matched, but nothing was blocked.
 */
import * as v from 'valibot';
import { parseRulesetId } from '../ids.js';
import { own } from '../record.js';

export const BUCKETS_FILE = 'buckets.json';

/** Categories the panel groups by, in display order. */
export const CATEGORIES = ['ads', 'tracking', 'malware', 'popup', 'cookies', 'annoyance', 'params', 'regional', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

const END = -1;
/** Reserved index of exception rules (`compiler/emit/buckets.ts` `ALLOW_BUCKET`). */
const ALLOW = -2;
/** What `bucketOf` returns for an exception rule: matched, nothing blocked. */
export const ALLOW_BUCKET_ID = 'allow';
const MAX_BUCKETS = 1_000;
const MAX_RUNS = 200_000;

const Run = v.tuple([v.pipe(v.number(), v.integer(), v.minValue(0)), v.pipe(v.number(), v.integer(), v.minValue(ALLOW))]);
const Schema = v.strictObject({
  schema: v.literal(1),
  buckets: v.pipe(
    v.array(
      v.strictObject({
        id: v.pipe(v.string(), v.maxLength(64)),
        name: v.pipe(v.string(), v.maxLength(80)),
        category: v.pipe(v.string(), v.maxLength(32)),
      }),
    ),
    v.maxLength(MAX_BUCKETS),
  ),
  rulesets: v.record(
    v.pipe(
      v.string(),
      v.check((id) => parseRulesetId(id) === id, 'invalid ruleset id'),
    ),
    v.pipe(v.array(Run), v.maxLength(MAX_RUNS)),
  ),
});

interface Bucket {
  readonly id: string;
  readonly name: string;
  readonly category: string;
}

type Runs = readonly (readonly [number, number])[];

export interface BucketMap {
  readonly buckets: readonly Bucket[];
  readonly rulesets: Readonly<Record<string, Runs>>;
}

const ascending = (runs: Runs): boolean => runs.every(([first], i) => i === 0 || first > (runs[i - 1]?.[0] ?? 0));

/** Validates a parsed `buckets.json`; `null` when it is not exactly the compiler's format. */
export function readBuckets(raw: unknown): BucketMap | null {
  const parsed = v.safeParse(Schema, raw);
  if (!parsed.success) return null;
  const { buckets, rulesets } = parsed.output;
  const indexOk = Object.values(rulesets).every((runs) => ascending(runs) && runs.every(([, b]) => b < buckets.length));
  return indexOk ? { buckets, rulesets } : null;
}

/** Bucket index of `id` in `runs` (binary search over run starts), or -1. */
function indexOf(runs: Runs, id: number): number {
  let lo = 0;
  let hi = runs.length - 1;
  let found = END;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, bucket] = runs[mid] ?? [0, END];
    if (first <= id) {
      found = bucket;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The ruleset's category, from its own `other:<category>` fallback bucket. */
export function rulesetCategory(map: BucketMap, rulesetId: string): Category {
  const runs = own(map.rulesets, rulesetId) ?? [];
  const found = new Set(runs.map(([, b]) => map.buckets[b]?.id).filter((id): id is string => id?.startsWith('other:') === true));
  const [only] = [...found];
  const category = found.size === 1 && only !== undefined ? only.slice('other:'.length) : 'other';
  return (CATEGORIES as readonly string[]).includes(category) ? (category as Category) : 'other';
}

/** The bucket id of one static rule: a company id, or `other:<category>`. */
export function bucketOf(map: BucketMap, rulesetId: string, ruleId: number): string {
  const runs = own(map.rulesets, rulesetId);
  const index = runs === undefined ? END : indexOf(runs, ruleId);
  if (index === ALLOW) return ALLOW_BUCKET_ID;
  const bucket = index < 0 ? undefined : map.buckets[index];
  return bucket?.id ?? `other:${rulesetCategory(map, rulesetId)}`;
}
