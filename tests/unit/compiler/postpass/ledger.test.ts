import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import type { BucketedRule } from '../../../../compiler/postpass/coalesce.js';
import { assignIds, emptyLedger, LedgerSchema, parseLedger, ruleKey, serialiseLedger, type Ledger } from '../../../../compiler/postpass/ledger.js';

const src = { text: 't', source: { list: 'l', line: 1, text: 't' }, fixes: [] };
const b = (condition: DnrRule['condition'], bucket = 'other:ads', priority = 10): BucketedRule =>
  ({ rule: { id: 999, priority, action: { type: 'block' }, condition }, sources: [src], bucket });

describe('rule keys (filter-pipeline notes §6.7)', () => {
  test('a coalesced rule keeps its key while its hosts change', () => {
    const one = ruleKey(b({ requestDomains: ['a.example', 'b.example'], resourceTypes: ['script'] }, 'google'));
    expect(ruleKey(b({ urlFilter: '||c.example^', resourceTypes: ['script'] }, 'google'))).toBe(one);
    expect(one).toMatch(/^b:[0-9a-f]{20}:google$/);
    expect(ruleKey(b({ requestDomains: ['a.example'], resourceTypes: ['script'] }, 'meta'))).not.toBe(one);
    expect(ruleKey(b({ requestDomains: ['a.example'], resourceTypes: ['image'] }, 'google'))).not.toBe(one);
    const withInit = ruleKey(b({ requestDomains: ['a.example'], initiatorDomains: ['s.example'] }));
    expect(ruleKey(b({ requestDomains: ['z.example'], initiatorDomains: ['s.example'] }))).toBe(withInit);
    expect(ruleKey(b({ requestDomains: ['a.example'], initiatorDomains: ['t.example'] }))).not.toBe(withInit);
  });

  test('a rule with a path or regex is keyed by its canonical form', () => {
    const k = ruleKey(b({ urlFilter: '||a.example/ad.js', resourceTypes: ['script', 'image'] }));
    expect(k).toMatch(/^r:[0-9a-f]{20}$/);
    expect(ruleKey(b({ resourceTypes: ['image', 'script'], urlFilter: '||a.example/ad.js' }))).toBe(k);
    expect(ruleKey(b({ urlFilter: '||a.example/ad.js', resourceTypes: ['script', 'image'] }, 'other:ads', 11))).not.toBe(k);
  });
});

describe('id assignment from the ledger (P1-24)', () => {
  test('new keys get ids from nextId in key order; known keys keep theirs; output sorted by id', () => {
    const rules = [b({ urlFilter: '||x.example/1' }), b({ urlFilter: '||x.example/2' })];
    const first = assignIds('ubo', rules, emptyLedger('ubo'));
    expect(first.rules.map((r) => r.rule.id).sort()).toEqual([1, 2]);
    expect(first.ledger.nextId).toBe(3);
    const second = assignIds('ubo', [b({ urlFilter: '||x.example/3' }), ...rules], first.ledger);
    expect(second.rules.map((r) => r.rule.id)).toEqual([1, 2, 3]);
    expect(second.ledger.nextId).toBe(4);
  });

  test('a removed key keeps its ledger entry and its id is never given to another rule', () => {
    const a = b({ urlFilter: '||x.example/a' });
    const one = assignIds('ubo', [a], emptyLedger('ubo'));
    const two = assignIds('ubo', [b({ urlFilter: '||x.example/b' })], one.ledger);
    expect(two.rules[0]?.rule.id).toBe(2);
    expect(Object.keys(two.ledger.entries)).toHaveLength(2);
    expect(assignIds('ubo', [a], two.ledger).rules[0]?.rule.id).toBe(1);
  });

  test('host-only rules that share a b: key fall back to full keys (seen on the pinned lists)', () => {
    const one = b({ requestDomains: ['viads.example'], initiatorDomains: ['s.example', 't.example'] });
    const two = b({ requestDomains: ['shinobi.example'], initiatorDomains: ['s.example', 't.example'] });
    expect(ruleKey(one)).toBe(ruleKey(two));
    const out = assignIds('ubo', [one, two], emptyLedger('ubo'));
    expect(Object.keys(out.ledger.entries).every((k) => k.startsWith('c:'))).toBe(true);
    expect(out.rules.map((r) => r.rule.id)).toEqual([1, 2]);
  });

  test('two identical rules fail the build; so does a ledger of another ruleset', () => {
    const r = b({ urlFilter: '||x.example/a' });
    expect(() => assignIds('ubo', [r, r], emptyLedger('ubo'))).toThrow(/same ledger key/);
    expect(() => assignIds('ubo', [r], emptyLedger('easylist'))).toThrow(/ledger of "easylist"/);
  });

  test('property: ids are stable across builds with changed host lists, and never reused', () => {
    const hostSet = fc.uniqueArray(fc.constantFrom('a.example', 'b.example', 'c.example', 'd.example', 'e.example'), { minLength: 1 });
    const build = fc.record({
      buckets: fc.uniqueArray(fc.constantFrom('google', 'meta', 'other:ads', 'amazon'), { minLength: 1 }),
      hosts: hostSet,
      paths: fc.uniqueArray(fc.constantFrom('/1', '/2', '/3', '/4'), { maxLength: 3 }),
    });
    fc.assert(fc.property(fc.array(build, { minLength: 2, maxLength: 6 }), (builds) => {
      let ledger: Ledger = emptyLedger('ubo');
      const owner = new Map<number, string>();
      const idOf = new Map<string, number>();
      for (const spec of builds) {
        const rules = [...spec.buckets.map((bk) => b({ requestDomains: spec.hosts }, bk)), ...spec.paths.map((p) => b({ urlFilter: `||x.example${p}` }))];
        const out = assignIds('ubo', rules, ledger);
        for (const r of out.rules) {
          const key = ruleKey(r);
          expect(owner.get(r.rule.id) ?? key).toBe(key);
          expect(idOf.get(key) ?? r.rule.id).toBe(r.rule.id);
          owner.set(r.rule.id, key);
          idOf.set(key, r.rule.id);
        }
        expect(new Set(out.rules.map((r) => r.rule.id)).size).toBe(out.rules.length);
        ledger = out.ledger;
      }
    }));
  });
});

describe('ledger file (versioned)', () => {
  test('serialises with sorted keys and parses back', () => {
    const { ledger } = assignIds('ubo', [b({ urlFilter: '||x.example/b' }), b({ urlFilter: '||x.example/a' })], emptyLedger('ubo'));
    const text = serialiseLedger(ledger);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseLedger(text, 'ubo.json')).toEqual(ledger);
    const keys = Object.keys((JSON.parse(text) as Ledger).entries);
    expect(keys).toEqual([...keys].sort());
  });

  test('rejects a newer schema, duplicate ids and a nextId not above every id', () => {
    expect(() => parseLedger(JSON.stringify({ schema: 2, ruleset: 'ubo', nextId: 1, entries: {} }), 'f')).toThrow(/schema/);
    expect(LedgerSchema.safeParse({ schema: 1, ruleset: 'ubo', nextId: 3, entries: { 'r:a': 1, 'r:b': 1 } }).success).toBe(false);
    expect(LedgerSchema.safeParse({ schema: 1, ruleset: 'ubo', nextId: 2, entries: { 'r:a': 2 } }).success).toBe(false);
  });
});
