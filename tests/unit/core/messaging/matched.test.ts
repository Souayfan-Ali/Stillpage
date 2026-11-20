import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { readBuckets, type BucketMap } from '../../../../src/core/buckets/buckets.js';
import { MatchedRulesSchema, MAX_LISTED_RULES, MAX_NAMED_ROWS, summariseMatches, type OwnRuleKind } from '../../../../src/core/messaging/matched.js';

const NOW = 1_800_000_000_000;
function mapOf(raw: unknown): BucketMap {
  const read = readBuckets(raw);
  if (read === null) throw new Error('invalid map');
  return read;
}

const map = mapOf({
  schema: 1,
  buckets: [
    { id: 'google', name: 'Google', category: 'company' },
    { id: 'meta', name: 'Meta', category: 'company' },
    { id: 'other:ads', name: 'Other', category: 'ads' },
    { id: 'other:tracking', name: 'Other', category: 'tracking' },
  ],
  rulesets: { ubo: [[1, 0], [3, 2], [9, -1]], easyprivacy: [[1, 1], [2, 3], [5, -1]] },
});

const m = (rulesetId: string, ruleId: number): { rulesetId: string; ruleId: number } => ({ rulesetId, ruleId });
const none = (): OwnRuleKind => 'drop';

describe('summariseMatches (q/matchedRules, P2-11)', () => {
  test('counts per bucket inside each category; Other last; categories in display order', () => {
    const matches = [m('ubo', 1), m('ubo', 2), m('ubo', 4), m('easyprivacy', 1), m('easyprivacy', 3), m('easyprivacy', 1)];
    const summary = summariseMatches(map, matches, none, NOW);
    expect(summary).toEqual({
      kind: 'counts',
      stale: false,
      at: NOW,
      total: 6,
      groups: [
        { category: 'ads', count: 3, buckets: [{ id: 'google', name: 'Google', count: 2 }, { id: 'other:ads', name: null, count: 1 }] },
        { category: 'tracking', count: 3, buckets: [{ id: 'meta', name: 'Meta', count: 2 }, { id: 'other:tracking', name: null, count: 1 }] },
      ],
      rules: [m('easyprivacy', 1), m('easyprivacy', 3), m('ubo', 1), m('ubo', 2), m('ubo', 4)],
      moreRules: 0,
    });
    expect(v.safeParse(MatchedRulesSchema, summary).success).toBe(true);
  });

  test('unknown ids and rulesets fall to Other; a company seen in two categories is counted in each', () => {
    const summary = summariseMatches(map, [m('ubo', 500), m('cookies', 7), m('easyprivacy', 1), m('ubo', 1)], none, NOW);
    expect(summary.groups.map((g) => [g.category, g.buckets.map((b) => [b.id, b.count])])).toEqual([
      ['ads', [['google', 1], ['other:ads', 1]]],
      ['tracking', [['meta', 1]]],
      ['other', [['other:other', 1]]],
    ]);
  });

  test('our own dynamic and session rules: allow rules dropped, pop-up redirects counted as pop-ups', () => {
    const kinds: Record<string, OwnRuleKind> = { '_dynamic:1': 'drop', '_dynamic:1200001': 'popup', '_session:5': 'other' };
    const summary = summariseMatches(map, [m('_dynamic', 1), m('_dynamic', 1200001), m('_session', 5)], (r, id) => kinds[`${r}:${String(id)}`] ?? 'drop', NOW);
    expect(summary).toMatchObject({ total: 2, groups: [{ category: 'popup', count: 1 }, { category: 'other', count: 1 }] });
    expect(summary.rules).toEqual([m('_dynamic', 1200001), m('_session', 5)]);
  });

  test('names hidden for owner review fold into Other of their category', () => {
    const summary = summariseMatches(map, [m('ubo', 1), m('ubo', 4)], none, NOW, new Set(['google']));
    expect(summary.groups[0]?.buckets).toEqual([{ id: 'other:ads', name: null, count: 2 }]);
  });

  test('the rule list is capped with a count of the rest; nothing matched is an empty summary', () => {
    const many = Array.from({ length: MAX_LISTED_RULES + 5 }, (_, i) => m('ubo', 3 + (i % 6) + Math.floor(i / 6) * 0)).concat(
      Array.from({ length: MAX_LISTED_RULES + 5 }, (_, i) => m('ubo', 1000 + i)),
    );
    const summary = summariseMatches(map, many, none, NOW);
    expect(summary.rules.length).toBe(MAX_LISTED_RULES);
    expect(summary.rules.length + summary.moreRules).toBe(6 + MAX_LISTED_RULES + 5);
    expect(summariseMatches(map, [], none, NOW)).toEqual({ kind: 'counts', stale: false, at: NOW, total: 0, groups: [], rules: [], moreRules: 0 });
  });

  test('the schema refuses extra keys, unknown categories and absurd counts', () => {
    const ok = summariseMatches(map, [m('ubo', 1)], none, NOW);
    expect(v.safeParse(MatchedRulesSchema, { ...ok, extra: 1 }).success).toBe(false);
    expect(v.safeParse(MatchedRulesSchema, { ...ok, groups: [{ category: 'evil', count: 1, buckets: [] }] }).success).toBe(false);
    expect(v.safeParse(MatchedRulesSchema, { ...ok, total: -1 }).success).toBe(false);
    expect(v.safeParse(MatchedRulesSchema, { kind: 'unavailable' }).success).toBe(true);
  });
});

describe('row cap (review HIGH: the answer must pass its own schema)', () => {
  test('more companies than MAX_NAMED_ROWS fold into Other; the answer validates', () => {
    const n = MAX_NAMED_ROWS + 30;
    const buckets = [...Array.from({ length: n }, (_, i) => ({ id: `c${String(i)}`, name: `Company ${String(i)}`, category: 'company' })), { id: 'other:ads', name: 'Other', category: 'ads' }];
    const big = mapOf({ schema: 1, buckets, rulesets: { ubo: [...Array.from({ length: n }, (_, i) => [i + 1, i]), [n + 1, n], [n + 2, -1]] } });
    const matches = Array.from({ length: n }, (_, i) => m('ubo', i + 1)).concat([m('ubo', 1), m('ubo', n + 1)]);
    const summary = summariseMatches(big, matches, none, NOW);
    const rows = summary.groups[0]?.buckets ?? [];
    expect(rows).toHaveLength(MAX_NAMED_ROWS + 1);
    expect(rows[0]).toEqual({ id: 'c0', name: 'Company 0', count: 2 });
    expect(rows.at(-1)).toEqual({ id: 'other:ads', name: null, count: n + 2 - rows.slice(0, -1).reduce((s, r) => s + r.count, 0) });
    expect(rows.reduce((s, r) => s + r.count, 0)).toBe(summary.total);
    expect(v.safeParse(MatchedRulesSchema, summary).success).toBe(true);
  });
});

describe('exception rules are not counted (compiler REVIEW item, P2-11)', () => {
  test('a rule in a -2 run (allow / allowAllRequests) is dropped from counts and the rule list', () => {
    const withAllow = mapOf({
      schema: 1,
      buckets: [{ id: 'google', name: 'Google', category: 'company' }, { id: 'other:ads', name: 'Other', category: 'ads' }],
      rulesets: { ubo: [[1, 0], [2, -2], [3, 1], [4, -1]] },
    });
    const summary = summariseMatches(withAllow, [m('ubo', 1), m('ubo', 2), m('ubo', 3)], none, NOW);
    expect(summary.total).toBe(2);
    expect(summary.rules).toEqual([m('ubo', 1), m('ubo', 3)]);
  });
});
