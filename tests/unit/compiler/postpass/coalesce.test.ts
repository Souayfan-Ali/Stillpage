import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { ConvertedRule } from '../../../../compiler/convert/convert.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { assertBucketOverhead, bucketRuleset } from '../../../../compiler/postpass/buckets.js';
import { canonicalKey } from '../../../../compiler/postpass/canonical.js';
import { coalesce, pruneHosts } from '../../../../compiler/postpass/coalesce.js';
import { mergeInitiators } from '../../../../compiler/postpass/initiators.js';
import { verdict, type Req } from './match.js';

const HOSTS = ['a.example', 'x.a.example', 'b.example', 'c.example', 'ads.tracker.example', 'tracker.example'];
const INITIATORS = ['site.example', 'news.example', 'shop.example', 'm.site.example'];
const src = (line: number) => ({ text: 't', source: { list: 'l', line, text: 't' }, fixes: [] });
const conv = (rule: DnrRule, line = 1): ConvertedRule => ({ rule, sources: [src(line)] });
const company = (h: string): string => (h.endsWith('tracker.example') ? 'tracker-co' : 'other:ads');

/** Host-only rules over a small universe, so collisions (and merges) are frequent. */
const arbHostRule: fc.Arbitrary<DnrRule> = fc.record({
  id: fc.integer({ min: 1, max: 1_000 }),
  priority: fc.constantFrom(10, 110, 100_310),
  action: fc.constantFrom({ type: 'block' as const }, { type: 'allow' as const }),
  condition: fc.record({
    hostForm: fc.oneof(fc.constantFrom(...HOSTS).map((h) => ({ urlFilter: `||${h}^` })),
      fc.uniqueArray(fc.constantFrom(...HOSTS), { minLength: 1, maxLength: 3 }).map((d) => ({ requestDomains: d }))),
    init: fc.option(fc.uniqueArray(fc.constantFrom(...INITIATORS), { minLength: 1, maxLength: 2 }), { nil: undefined }),
    types: fc.option(fc.constantFrom(['script'] as const, ['image', 'script'] as const), { nil: undefined }),
  }).map(({ hostForm, init, types }) => ({ ...hostForm, ...(init && { initiatorDomains: init }), ...(types && { resourceTypes: [...types] }) })),
});
const arbReq: fc.Arbitrary<Req> = fc.record({
  host: fc.constantFrom(...HOSTS, 'y.x.a.example', 'unrelated.example'),
  initiator: fc.constantFrom(...INITIATORS, 'other.example'),
  type: fc.constantFrom('script', 'image', 'xmlhttprequest'),
});

/** (host, signature) pairs of host-only rules. */
function pairs(rules: readonly DnrRule[]): Set<string> {
  return new Set(rules.flatMap((r) => {
    const { urlFilter, requestDomains, ...rest } = r.condition;
    const hosts = requestDomains ?? (urlFilter ? [urlFilter.slice(2, -1)] : []);
    const sig = canonicalKey({ ...r, id: 1, condition: rest });
    return hosts.map((h) => `${h}|${sig}`);
  }));
}

describe('bucketed coalescing', () => {
  test('merges host-only rules per (signature, bucket), prunes covered hosts, keeps other rules apart', () => {
    const block = (urlFilter: string, line: number) => conv({ id: line, priority: 10, action: { type: 'block' }, condition: { urlFilter } }, line);
    const out = coalesce([block('||a.example^', 1), block('||x.a.example^', 2), block('||b.example^', 3),
      block('||ads.tracker.example^', 4), block('||a.example/path', 5),
      conv({ id: 6, priority: 10, action: { type: 'block' }, condition: { regexFilter: 'ad[0-9]' } }, 6)], company, 'other:ads');
    expect(out.map((r) => [r.bucket, r.rule.condition, r.sources.map((s) => s.source.line)])).toEqual([
      ['other:ads', { urlFilter: '||a.example/path' }, [5]],
      ['other:ads', { regexFilter: 'ad[0-9]' }, [6]],
      ['other:ads', { requestDomains: ['a.example', 'b.example'] }, [1, 2, 3]],
      ['tracker-co', { urlFilter: '||ads.tracker.example^' }, [4]],
    ]);
  });

  test('excludedRequestDomains keeps the requestDomains form even for one host', () => {
    const r = conv({ id: 1, action: { type: 'block' }, condition: { requestDomains: ['a.example'], excludedRequestDomains: ['x.a.example'] } });
    expect(coalesce([r], company, 'other:ads')[0]?.rule.condition).toEqual({ requestDomains: ['a.example'], excludedRequestDomains: ['x.a.example'] });
  });

  test('pruneHosts drops a host whose parent is listed, label-aligned only', () => {
    expect(pruneHosts(['x.a.example', 'a.example', 'ba.example', 'a.example'])).toEqual(['a.example', 'ba.example']);
  });

  test('property: the (host, signature) set is preserved (up to hosts covered by a listed parent)', () => {
    fc.assert(fc.property(fc.array(arbHostRule, { maxLength: 25 }), (rules) => {
      const before = pairs(rules);
      const after = pairs(coalesce(rules.map((r, i) => conv(r, i)), company, 'other:ads').map((r) => r.rule));
      for (const p of after) expect(before.has(p)).toBe(true);
      for (const p of before) {
        const [host, sig] = p.split('|') as [string, string];
        const parents = host.split('.').map((_, i, l) => l.slice(i).join('.'));
        expect(parents.some((h) => after.has(`${h}|${sig}`)), p).toBe(true);
      }
    }));
  });

  test('property: coalescing and the initiator merge leave every verdict unchanged', () => {
    fc.assert(fc.property(fc.array(arbHostRule, { maxLength: 25 }), fc.array(arbReq, { minLength: 1, maxLength: 20 }), (rules, reqs) => {
      const coalesced = coalesce(rules.map((r, i) => conv(r, i)), company, 'other:ads');
      const merged = mergeInitiators(coalesced);
      for (const req of reqs) {
        const expected = verdict(rules, req);
        expect(verdict(coalesced.map((r) => r.rule), req)).toBe(expected);
        expect(verdict(merged.map((r) => r.rule), req)).toBe(expected);
      }
    }));
  });
});

describe('initiator merge', () => {
  const rule = (init: string[], priority = 110, bucket = 'b'): { rule: DnrRule; sources: ConvertedRule['sources']; bucket: string } =>
    ({ rule: { id: 1, priority, action: { type: 'block' }, condition: { urlFilter: '||a.example^', initiatorDomains: init } }, sources: [src(init.length)], bucket });

  test('merges only equal priority and equal bucket; keeps every source', () => {
    const out = mergeInitiators([rule(['s.example']), rule(['n.example']), rule(['x.example'], 210), rule(['y.example'], 110, 'other')]);
    expect(out.map((r) => [r.rule.priority, r.bucket, r.rule.condition.initiatorDomains])).toEqual([
      [110, 'b', ['n.example', 's.example']], [210, 'b', ['x.example']], [110, 'other', ['y.example']]]);
    expect(out[0]?.sources).toHaveLength(2);
  });
});

describe('bucket overhead', () => {
  test('reports extra rules over maximal coalescing and fails above the budget', () => {
    const rules = ['||a.example^', '||ads.tracker.example^'].map((u, i) => conv({ id: i + 1, priority: 10, action: { type: 'block' }, condition: { urlFilter: u } }, i));
    const r = bucketRuleset(rules, (h) => (h.endsWith('tracker.example') ? 'tracker-co' : undefined), 'ads');
    expect([r.rules.length, r.maximal]).toEqual([2, 1]);
    expect(r.rules.map((x) => x.bucket).sort()).toEqual(['other:ads', 'tracker-co']);
    expect(assertBucketOverhead([r])).toBe(1);
    expect(() => assertBucketOverhead([r], 0)).toThrow(/cost 1 extra rules \(budget 0\)/);
  });
});
