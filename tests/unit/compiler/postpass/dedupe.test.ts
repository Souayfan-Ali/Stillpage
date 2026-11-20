import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { ConvertedRule } from '../../../../compiler/convert/convert.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { canonicalise, canonicalKey } from '../../../../compiler/postpass/canonical.js';
import { dedupe } from '../../../../compiler/postpass/dedupe.js';
import { arbRule, scrambled } from './arbitraries.js';

const src = (line: number) => ({ text: 't', source: { list: 'l', line, text: 't' }, fixes: [] });
const converted = (rule: DnrRule, line: number): ConvertedRule => ({ rule, sources: [src(line)] });

describe('canonical form', () => {
  test('property: canonicalisation is idempotent', () => {
    fc.assert(fc.property(arbRule, (r) => {
      const once = canonicalise(r);
      expect(canonicalise(once)).toEqual(once);
      expect(JSON.stringify(canonicalise(once))).toBe(JSON.stringify(once));
    }));
  });

  test('property: order and repetition of set-like arrays, key order and id do not change the key', () => {
    fc.assert(fc.property(arbRule, (r) => {
      expect(canonicalKey(scrambled(r))).toBe(canonicalKey(r));
    }));
  });

  test('defaults are removed and priority is explicit', () => {
    const r = canonicalise({ id: 3, action: { type: 'block' }, condition: { urlFilter: '||x^', isUrlFilterCaseSensitive: false } });
    expect(r).toEqual({ id: 3, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||x^' } });
    expect(canonicalKey({ id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||x^', isUrlFilterCaseSensitive: true } }))
      .not.toBe(canonicalKey(r));
  });

  test('order-sensitive arrays (header operations) keep their order', () => {
    const headers = [{ header: 'a', operation: 'append' as const, value: '1' }, { header: 'a', operation: 'set' as const, value: '2' }];
    const r: DnrRule = { id: 1, action: { type: 'modifyHeaders', responseHeaders: headers }, condition: { urlFilter: '*' } };
    expect(canonicalise(r).action.responseHeaders).toEqual(headers);
    expect(canonicalKey(r)).not.toBe(canonicalKey({ ...r, action: { ...r.action, responseHeaders: [...headers].reverse() } }));
  });

  test('the input is not modified', () => {
    const r: DnrRule = { id: 1, action: { type: 'block' }, condition: { requestDomains: ['b.example', 'a.example'] } };
    const before = JSON.stringify(r);
    canonicalise(r);
    expect(JSON.stringify(r)).toBe(before);
  });
});

describe('dedupe', () => {
  test('property: idempotent, keeps one rule per canonical key, and keeps every source', () => {
    fc.assert(fc.property(fc.array(arbRule, { maxLength: 30 }), fc.array(fc.nat(29), { maxLength: 10 }), (rules, dupIdx) => {
      const base = rules.map((r, i) => converted(r, i));
      const withDups = [...base, ...dupIdx.flatMap((i) => (base[i] ? [converted(scrambled(base[i].rule), 100 + i)] : []))];
      const once = dedupe(withDups);
      const keys = once.rules.map((r) => canonicalKey(r.rule));
      expect(new Set(keys).size).toBe(keys.length);
      expect(new Set(keys)).toEqual(new Set(withDups.map((r) => canonicalKey(r.rule))));
      expect(once.rules.flatMap((r) => r.sources)).toHaveLength(withDups.length);
      expect(once.removed).toBe(withDups.length - once.rules.length);
      expect(dedupe(once.rules).rules).toEqual(once.rules);
    }));
  });

  test('the survivor keeps the first id and gains the duplicate\'s source', () => {
    const a: DnrRule = { id: 7, priority: 1, action: { type: 'block' }, condition: { requestDomains: ['a.example', 'b.example'] } };
    const b: DnrRule = { id: 9, action: { type: 'block' }, condition: { requestDomains: ['b.example', 'a.example', 'a.example'] } };
    const r = dedupe([converted(a, 1), converted(b, 2)]);
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]?.rule.id).toBe(7);
    expect(r.rules[0]?.sources.map((s) => s.source.line)).toEqual([1, 2]);
  });
});
