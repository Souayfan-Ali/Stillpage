import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { createMatcher, tokensOf } from '../../../../src/content/cosmetic-generic/matcher.js';
import { lookupToken, type GenericData } from '../../../../src/core/generic/data.js';
import { leadingToken, tokenHash } from '../../../../src/core/generic/token.js';
import type { Hostname } from '../../../../src/core/ids.js';

/**
 * P3-17 item 1: the cheaper survey must give exactly what the P2-24 code gave. The reference below is
 * the P2-24 code, copied unchanged (lookup by hash computed twice, every class string split, one
 * lookup per token, each selector handed out once).
 */
function referenceLookup(data: GenericData, token: string): readonly string[] {
  const indices = Object.hasOwn(data.tokens, String(tokenHash(token))) ? data.tokens[String(tokenHash(token))] ?? [] : [];
  return indices.map((i) => data.selectors[i] ?? '').filter((s) => leadingToken(s) === token);
}

function referenceMatcher(packs: readonly GenericData[]): (id: unknown, classes: unknown) => readonly string[] {
  const handed = new Set<string>();
  const seen = new Set<string>();
  return (id, classes) => {
    const found: string[] = [];
    for (const token of tokensOf(id, classes)) {
      if (seen.has(token)) continue;
      seen.add(token);
      for (const d of packs) found.push(...referenceLookup(d, token));
    }
    return found.filter((s) => {
      if (handed.has(s)) return false;
      handed.add(s);
      return true;
    });
  };
}

function data(selectors: readonly string[], pack = 'ads'): GenericData {
  const sorted = [...new Set(selectors)].sort();
  const tokens: Record<string, number[]> = {};
  sorted.forEach((s, i) => {
    const t = leadingToken(s);
    if (t !== null) (tokens[String(tokenHash(t))] ??= []).push(i);
  });
  return { v: 1, pack, selectors: sorted, tokens, always: [], unhide: [], exceptions: [], off: [] };
}

const HOST = 'news.example' as Hostname;
const NAMES = ['a', 'b', 'ad', 'ad-1', 'x', 'top', 'promo', 'b-2'];
const name = fc.constantFrom(...NAMES);
const selector = fc.tuple(fc.constantFrom('.', '#', 'div.', 'span#'), name, fc.constantFrom('', ' > img', ':not(.k)', '.x')).map(([a, b, c]) => `${a}${b}${c}`);
const classAttr = fc.array(fc.tuple(name, fc.constantFrom(' ', '\t', '  ', '\n')), { maxLength: 4 }).map((parts) => parts.map(([n, sep]) => `${sep}${n}`).join(''));
const attr = (value: fc.Arbitrary<string>): fc.Arbitrary<unknown> => fc.oneof(value, fc.constant(null), fc.constant(''), fc.constant(7));
const element = fc.tuple(attr(name), attr(classAttr));

describe('lookupToken (P3-17: one hash per lookup)', () => {
  test('equals the P2-24 lookup on random data, colliding token lists included', () => {
    fc.assert(fc.property(fc.array(selector, { maxLength: 12 }), fc.array(fc.nat(11), { maxLength: 6 }), fc.oneof(name.map((n) => `.${n}`), name.map((n) => `#${n}`)), (selectors, extra, token) => {
      const base = data(selectors);
      const key = String(tokenHash(token));
      const padded = extra.filter((i) => i < base.selectors.length);
      const collide = { ...base, tokens: { ...base.tokens, [key]: [...(base.tokens[key] ?? []), ...padded] } };
      expect(lookupToken(base, token)).toEqual(referenceLookup(base, token));
      expect(lookupToken(collide, token)).toEqual(referenceLookup(collide, token));
    }));
  });

  test('no list for the hash: nothing; prototype keys are not lists', () => {
    const d = data(['.ad']);
    expect(lookupToken(d, '.none')).toEqual([]);
    expect(lookupToken({ ...d, tokens: {} }, '.ad')).toEqual([]);
  });
});

describe('matchElement (P3-17: a class string already seen is not split again)', () => {
  test('equals tokensOf + match of P2-24 on random element streams and packs', () => {
    fc.assert(fc.property(fc.array(selector, { maxLength: 10 }), fc.array(selector, { maxLength: 6 }), fc.array(element, { maxLength: 30 }), (a, b, elements) => {
      const packs = [data(a), data(b, 'trackers')];
      const fresh = createMatcher(packs, HOST);
      const reference = referenceMatcher(packs);
      for (const [id, classes] of elements) expect(fresh?.matchElement(id, classes)).toEqual(reference(id, classes));
    }));
  });

  test('the same class string twice: the second is free and finds nothing new', () => {
    const m = createMatcher([data(['.ad', '#top'])], HOST);
    expect(m?.matchElement(null, 'x ad')).toEqual(['.ad']);
    expect(m?.matchElement('top', 'x ad')).toEqual(['#top']);
    expect(m?.matchElement(null, 'x ad')).toEqual([]);
  });
});
