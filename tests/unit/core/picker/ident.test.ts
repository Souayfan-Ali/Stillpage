import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { cssAttributeValue, cssIdent, isHashedLike } from '../../../../src/core/picker/ident.js';
import { sanitiseSelector } from '../../../../src/core/sanitise/selector.js';

describe('cssIdent', () => {
  test.each([
    ['ad', 'ad'],
    ['ad-slot_2', 'ad-slot_2'],
    ['-webkit-x', '-webkit-x'],
    ['md:flex', 'md\\:flex'],
    ['w-1/2', 'w-1\\/2'],
    ['a.b', 'a\\.b'],
    ['grüße', 'grüße'],
  ])('%s → %s', (token, ident) => {
    expect(cssIdent(token)).toBe(ident);
  });

  test.each([[''], ['1col'], ['-2x'], ['--'], ['-'], ['a b'], ['a\nb'], ['a\u0000'], ['x'.repeat(201)]])('refuses %j (needs a digit escape, or unsafe)', (token) => {
    expect(cssIdent(token)).toBeNull();
  });

  test('every accepted ident is a class selector the sanitiser accepts', () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), (token) => {
      const ident = cssIdent(token);
      return ident === null || sanitiseSelector(`.${ident}`) === `.${ident}`;
    }));
  });
});

describe('cssAttributeValue', () => {
  test('quotes and escapes quotes and backslashes', () => {
    expect(cssAttributeValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(cssAttributeValue('a\\b')).toBe('"a\\\\b"');
  });

  test('refuses control characters, empty and over-long values', () => {
    expect(cssAttributeValue('a\nb')).toBeNull();
    expect(cssAttributeValue('')).toBeNull();
    expect(cssAttributeValue('x'.repeat(201))).toBeNull();
  });

  test('every accepted value is balanced inside an attribute selector', () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), (value) => {
      const quoted = cssAttributeValue(value);
      return quoted === null || sanitiseSelector(`[title=${quoted}]`) === `[title=${quoted}]`;
    }));
  });

  test('refuses what the sanitiser denies even inside a string', () => {
    for (const value of ['a{b', 'x}', '<b>', 'a/*b', 'URL(x)']) expect(cssAttributeValue(value)).toBeNull();
  });
});

describe('isHashedLike', () => {
  test.each([
    ['css-1x2y3z'], ['sc-bdVaJa'], ['jsx-2318512398'], ['Button_root__a1B2c'], ['_3xKq9'], ['a8f3c2d1'],
    ['styles__card--x7Yz2'], ['e1f9k2l0'], ['QhQ9Pd'], ['xY7kP2'],
  ])('%s looks generated', (token) => {
    expect(isHashedLike(token)).toBe(true);
  });

  test.each([
    ['ad'], ['ad-slot'], ['sidebar'], ['col-md-6'], ['h1'], ['mt-4'], ['banner300x250'], ['post-12'], ['adsbygoogle'], ['NewsletterBox'],
  ])('%s looks stable', (token) => {
    expect(isHashedLike(token)).toBe(false);
  });
});
