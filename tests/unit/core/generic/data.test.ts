import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  exceptionsFor, GENERIC_QUEUE, genericDataPath, genericFileWrap, isGenericData, isGenericOff, lookupToken, type GenericData,
} from '../../../../src/core/generic/data.js';
import { leadingToken, tokenHash } from '../../../../src/core/generic/token.js';
import type { Hostname } from '../../../../src/core/ids.js';

describe('leadingToken: first .class / #id of the leftmost compound', () => {
  test.each([
    ['.adsbox', '.adsbox'],
    ['#ad-banner', '#ad-banner'],
    ['div.ad', '.ad'],
    ['.ad > img', '.ad'],
    ['div#top.ad', '#top'],
    ['.md\\:flex', '.md:flex'],
    ['a[href^="https://ad."].x', '.x'],
    ['.ad:not(.keep)', '.ad'],
  ])('%s → %s', (selector, token) => {
    expect(leadingToken(selector)).toBe(token);
  });

  test.each([
    ['a[href^="https://ad."]'],
    ['div:not(.ad)'],
    ['div:has(> .ad)'],
    ['div .ad'],
    ['[class*="ad-"]'],
    ['.a, .b'],
    ['div > .a'],
    ['.'],
    ['[title="x.y"]'],
  ])('%s has no leading token', (selector) => {
    expect(leadingToken(selector)).toBeNull();
  });
});

describe('tokenHash', () => {
  test('16 bits, deterministic, prefix included', () => {
    expect(tokenHash('.ad')).toBe(tokenHash('.ad'));
    expect(tokenHash('.ad')).not.toBe(tokenHash('#ad'));
    fc.assert(fc.property(fc.string(), (s) => {
      const h = tokenHash(s);
      return Number.isInteger(h) && h >= 0 && h <= 0xffff;
    }));
  });

  test('known values (the surveyor must compute the same)', () => {
    expect([tokenHash('.adsbox'), tokenHash('#ad')]).toEqual([30726, 8904]);
  });
});

const data: GenericData = {
  v: 1, pack: 'ads',
  selectors: ['#ad', '.ad > img', '.adsbox', 'a[href^="https://ad."]'],
  tokens: { [String(tokenHash('#ad'))]: [0], [String(tokenHash('.ad'))]: [1], [String(tokenHash('.adsbox'))]: [2] },
  always: [3],
  unhide: ['.sponsor'],
  exceptions: [['example.com', ['.adsbox']], ['shop.example.org', ['#ad']]],
  off: ['nogeneric.example'],
};

describe('lookups', () => {
  test('lookupToken confirms the exact token behind a hash', () => {
    expect(lookupToken(data, '.adsbox')).toEqual(['.adsbox']);
    expect(lookupToken(data, '.ad')).toEqual(['.ad > img']);
    expect(lookupToken(data, '.nothing')).toEqual([]);
    const collide = { ...data, tokens: { [String(tokenHash('.ad'))]: [1, 2] } };
    expect(lookupToken(collide, '.ad')).toEqual(['.ad > img']);
  });

  test('exceptionsFor unions the host and its parents', () => {
    expect(exceptionsFor(data, 'a.example.com' as Hostname)).toEqual(['.adsbox']);
    expect(exceptionsFor(data, 'example.org' as Hostname)).toEqual([]);
    expect(exceptionsFor(data, 'shop.example.org' as Hostname)).toEqual(['#ad']);
  });

  test('isGenericOff covers sub-hosts', () => {
    expect(isGenericOff(data, 'www.nogeneric.example' as Hostname)).toBe(true);
    expect(isGenericOff(data, 'example.com' as Hostname)).toBe(false);
  });
});

describe('isGenericData (the surveyor reads the queue as untrusted)', () => {
  test('accepts the format', () => {
    expect(isGenericData(JSON.parse(JSON.stringify(data)))).toBe(true);
  });

  test.each([
    ['null', null],
    ['other version', { ...data, v: 2 }],
    ['index out of range', { ...data, always: [9] }],
    ['token list not indices', { ...data, tokens: { 1: ['x'] } }],
    ['selector not a string', { ...data, selectors: [1] }],
    ['unsorted exceptions', { ...data, exceptions: [['b.example', []], ['a.example', []]] }],
    ['bad exception', { ...data, exceptions: [['a.example', [1]]] }],
    ['off not strings', { ...data, off: [1] }],
    ['unhide not strings', { ...data, unhide: [null] }],
    ['tokens not an object', { ...data, tokens: [] }],
  ])('refuses %s', (_name, value) => {
    expect(isGenericData(value)).toBe(false);
  });
});

describe('packaging', () => {
  test('path and wrapper', () => {
    expect(genericDataPath('ads')).toBe('cosmetic/ads/generic.js');
    const { prefix, suffix } = genericFileWrap();
    expect(prefix).toBe(`(self.${GENERIC_QUEUE}=self.${GENERIC_QUEUE}||[]).push(`);
    expect(suffix).toBe(');\n');
  });
});
