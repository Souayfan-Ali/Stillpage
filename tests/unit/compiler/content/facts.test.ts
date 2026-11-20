import { describe, expect, test } from 'vitest';
import { dedupeFacts, resolveExceptions } from '../../../../compiler/content/facts.js';
import { fact } from './helpers.js';

describe('exception resolution (P1-27, ADR-010)', () => {
  test('an exception on the filter host or a parent removes the fact at build time', () => {
    const facts = [fact('a.example.com', 'h', '.ad'), fact('example.com', 'h', '.x')];
    const ex = [fact('example.com', 'u', '.ad')];
    const r = resolveExceptions(facts, ex, new Set(ex));
    expect(r.facts.map((f) => f.value)).toEqual(['.x']);
    expect(r.removed).toBe(1);
    expect(r.failOpen).toBe(0);
  });

  test('an exception on a sub-host of a filter host stays as a runtime exception', () => {
    const facts = [fact('example.com', 'h', '.ad')];
    const ex = [fact('a.example.com', 'u', '.ad'), fact('b.other.com', 'u', '.ad')];
    const r = resolveExceptions(facts, ex, new Set(ex));
    expect(r.facts.map((f) => `${f.host}:${f.kind}`)).toEqual(['example.com:h', 'a.example.com:u']);
  });

  test('exceptions of another pack apply and are counted as fail-open', () => {
    const facts = [fact('example.com', 'h', '.ad'), fact('example.com', 'h', '.b')];
    const theirs = fact('example.com', 'u', '.ad');
    const subTheirs = fact('x.example.com', 'u', '.b');
    const r = resolveExceptions(facts, [theirs, subTheirs], new Set());
    expect(r.facts.map((f) => `${f.host}:${f.kind}:${f.value}`)).toEqual(['example.com:h:.b', 'x.example.com:u:.b']);
    expect(r.failOpen).toBe(2);
  });

  test('style and procedural exceptions resolve at build time; one on a sub-host is counted as unresolved', () => {
    const facts = [fact('example.com', 'p', '{"p":1}'), fact('other.com', 's', '["b","x:y"]')];
    const ex = [fact('other.com', 'u', '["b","x:y"]'), fact('a.example.com', 'u', '{"p":1}')];
    const r = resolveExceptions(facts, ex, new Set(ex));
    expect(r.facts.map((f) => f.host)).toEqual(['example.com']);
    expect(r.unresolved).toBe(1);
  });

  test('scriptlet exceptions cancel invocations', () => {
    const facts = [fact('example.com', 'j', '["a"]'), fact('example.com', 'j', '["b"]')];
    const ex = [fact('www.example.com', 'n', '["a"]'), fact('example.com', 'n', '["b"]')];
    const r = resolveExceptions(facts, ex, new Set(ex));
    expect(r.facts.map((f) => `${f.host}:${f.kind}:${f.value}`)).toEqual(['example.com:j:["a"]', 'www.example.com:n:["a"]']);
  });

  test('dedupe keeps the first source of each (kind, value, host)', () => {
    expect(dedupeFacts([fact('a.com', 'h', '.x', 'one'), fact('a.com', 'h', '.x', 'two')]).map((f) => f.source.list)).toEqual(['one']);
  });
});

describe('cosmetic switches ($elemhide, $specifichide)', () => {
  test('only ||host^ forms are switches; facts on the host, its parents and sub-hosts get an exception on the host', async () => {
    const { switchFacts, switchHost } = await import('../../../../compiler/content/build.js');
    const { entry } = await import('./helpers.js');
    expect(switchHost(entry('@@||player.pl^$ehide'))).toBe('player.pl');
    expect(switchHost(entry('@@||a.pl^$ghide'))).toBeNull();
    expect(switchHost(entry('@@||a.pl^$ehide,badfilter'))).toBeNull();
    const out = switchFacts(['www.a.com'], [fact('a.com', 'h', '.x'), fact('x.www.a.com', 'p', '{}'), fact('b.com', 'h', '.y')]);
    expect(out.map((f) => `${f.host} ${f.kind} ${f.value}`)).toEqual(['www.a.com u .x', 'www.a.com u {}']);
  });
});
