/**
 * `buckets.json` (filter-pipeline notes §10, ADR-011, P1-26): `(rulesetId, ruleId) → bucket` plus each bucket's
 * display name and category, shipped for the privacy panel. Per ruleset, runs of consecutive ids
 * with the same bucket are stored as `[firstId, bucketIndex]`, closed by `[maxId + 1, -1]`, so an id
 * minted by a later ruleset release (always above every packaged id) resolves to no bucket ("Other").
 * Exception rules (`allow`, `allowAllRequests`) get the reserved index `ALLOW_BUCKET` (-2), so the
 * privacy panel never counts a matched exception as blocked (P2-11 review, closed in P2-25).
 */
import type { Entities } from '../entities/schema.js';
import type { BucketedRule } from '../postpass/coalesce.js';

const END = -1;
/** Reserved bucket index of exception rules: matched, but nothing was blocked. */
export const ALLOW_BUCKET = -2;
const ALLOW_TYPES: ReadonlySet<string> = new Set(['allow', 'allowAllRequests']);

interface BucketInfo {
  readonly id: string;
  readonly name: string;
  readonly category: string;
}

function infoOf(id: string, names: ReadonlyMap<string, string>): BucketInfo {
  if (id.startsWith('other:')) return { id, name: 'Other', category: id.slice('other:'.length) };
  return { id, name: names.get(id) ?? id, category: 'company' };
}

/** Runs `[firstId, bucketIndex]` for rules sorted by id, closed by the end marker. */
function runsOf(rules: readonly BucketedRule[], index: ReadonlyMap<string, number>): readonly (readonly [number, number])[] {
  const sorted = [...rules].sort((a, b) => a.rule.id - b.rule.id);
  const runs: [number, number][] = [];
  let prev: { id: number; bucket: number } | undefined;
  for (const r of sorted) {
    const bucket = ALLOW_TYPES.has(r.rule.action.type) ? ALLOW_BUCKET : (index.get(r.bucket) ?? END);
    if (prev === undefined || r.rule.id !== prev.id + 1 || bucket !== prev.bucket) runs.push([r.rule.id, bucket]);
    prev = { id: r.rule.id, bucket };
  }
  const last = sorted.at(-1);
  return last === undefined ? [] : [...runs, [last.rule.id + 1, END]];
}

/** The buckets value for every slot with rules (slot order kept). */
export function bucketsOf(slots: ReadonlyMap<string, readonly BucketedRule[]>, entities: Entities): unknown {
  const names = new Map(entities.companies.map((c) => [c.id, c.name]));
  const ids = [...new Set([...slots.values()].flat().map((r) => r.bucket))].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const rulesets = Object.fromEntries([...slots].filter(([, rules]) => rules.length > 0).map(([id, rules]) => [id, runsOf(rules, index)]));
  return { schema: 1, buckets: ids.map((id) => infoOf(id, names)), rulesets };
}

/** Resolves a rule id with the runs of one ruleset (what the privacy panel will do). */
export function bucketIndexOf(runs: readonly (readonly [number, number])[], id: number): number {
  let found = END;
  for (const [first, bucket] of runs) {
    if (first > id) break;
    found = bucket;
  }
  return found;
}
