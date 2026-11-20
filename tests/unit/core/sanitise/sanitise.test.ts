import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  ALLOWED_PROPERTIES,
  DENIED_DECLARATION_TOKENS,
  sanitiseDeclarations,
} from '../../../../src/core/sanitise/declaration.js';
import { HIDE_DECLARATION, hideRule, sanitiseSelector, styleRule } from '../../../../src/core/sanitise/selector.js';
import { MAX_DECLARATION_LENGTH, MAX_SELECTOR_LENGTH } from '../../../../src/core/limits.js';

describe('sanitiseSelector: accepted', () => {
  test.each([
    ['.ad'],
    ['#banner > div.sponsored'],
    ['div[id^="ad-"]'],
    ['a[href*="mailto:x@y.z"]'],
    ['.a\\:b'],
    ['.w-1\\/2'],
    ['a[title="\\75 rl"]'],
    ['div:has(> .ad), aside:not(.keep)'],
    ['[data-x=";"]'],
    ['ins.adsbygoogle:nth-child(2n+1)'],
  ])('%s', (selector) => {
    expect(sanitiseSelector(selector)).toBe(selector);
  });

  test('trims surrounding whitespace', () => {
    expect(sanitiseSelector('  .ad \n')).toBe('.ad');
  });
});

describe('sanitiseSelector: rejected', () => {
  test.each([
    ['empty', ''],
    ['blank', '   '],
    ['opening brace', '.a{color:red'],
    ['closing brace', '.a} body{background:url(//x)'],
    ['less-than', '</style><script>'],
    ['at-rule', '@import url(//evil)'],
    ['at-rule after whitespace', '  @media all'],
    ['comment', '.a/* x */'],
    ['NUL', '.a\u0000'],
    ['control character', '.a\u0007'],
    ['unbalanced bracket', 'div[id="x"'],
    ['unbalanced parenthesis', 'div:has(.a'],
    ['extra closing parenthesis', 'div).a'],
    ['unterminated string', 'a[href="x]'],
    ['trailing backslash', '.a\\'],
    ['url( whose quote the tokenizer does not see (review HIGH 1)', "a:is(url(x'),'))"],
    ['upper-case URL(', 'a:is(URL(x))'],
    ['hex escape spelling url (review HIGH 1)', "a:is(\\75 rl(x'),'))"],
    ['letter escape spelling url', "a:is(u\\rl(x'),'))"],
    ['escaped digit', '.\\31 a'],
    ['too long', `.${'a'.repeat(MAX_SELECTOR_LENGTH)}`],
  ])('%s', (_name, selector) => {
    expect(sanitiseSelector(selector)).toBeNull();
  });

  test('rejects non-strings', () => {
    expect(sanitiseSelector(7)).toBeNull();
    expect(sanitiseSelector(null)).toBeNull();
  });

  test('accepts exactly the maximum length', () => {
    const selector = `.${'a'.repeat(MAX_SELECTOR_LENGTH - 1)}`;
    expect(sanitiseSelector(selector)).toBe(selector);
  });

  test('never accepts a selector that could close or open a block', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = sanitiseSelector(text);
        expect(result === null || (!result.includes('{') && !result.includes('}'))).toBe(true);
      }),
    );
  });
});

describe('rule builders', () => {
  test('stock selectors only ever get display:none!important', () => {
    expect(HIDE_DECLARATION).toBe('display:none!important');
    expect(hideRule('.ad')).toBe('.ad{display:none!important}');
  });

  test('refuse unsafe input instead of building a rule', () => {
    expect(hideRule('.a}body{')).toBeNull();
    expect(styleRule('.a', 'background:url(//x)')).toBeNull();
    expect(styleRule('.a', 'opacity:0')).toBe('.a{opacity:0}');
  });
});

describe('sanitiseDeclarations: denied tokens', () => {
  test('the denylist covers security notes §4 and the extras', () => {
    expect(DENIED_DECLARATION_TOKENS).toEqual(
      expect.arrayContaining(['url(', 'image-set(', '@import', 'expression(', '\\', '}', '<']),
    );
  });

  test.each(DENIED_DECLARATION_TOKENS.map((token) => [token]))('rejects a block containing %j', (token) => {
    expect(sanitiseDeclarations(`opacity: 0; color: red ${token}`)).toBeNull();
  });

  test.each([
    ['upper-case URL(', 'background-color: URL(//x)'],
    ['mixed-case Image-Set(', 'background-color: Image-Set(x 1x)'],
    ['-webkit-image-set(', 'background-color: -webkit-image-set(x 1x)'],
    ['@IMPORT', 'color: red; @IMPORT x'],
    ['an escape that spells url', 'color: \\75 rl(x)'],
    ['a comment', 'color: red /* } */'],
    ['too long', `opacity: ${'0'.repeat(MAX_DECLARATION_LENGTH)}`],
  ])('rejects %s', (_name, text) => {
    expect(sanitiseDeclarations(text)).toBeNull();
  });

  test.each([
    ['an unclosed function (review HIGH 2)', 'width:calc(1px;color:red'],
    ['an unclosed bracket', 'width:[1px'],
    ['a stray closer', 'width:1px);color:red'],
    ['a ; inside a function', 'width:calc(1px;2px)'],
    ['a fixed overlay (review MEDIUM)', 'position:fixed;top:0'],
    ['a sticky element', 'position: Sticky !important'],
  ])('rejects %s', (_name, text) => {
    expect(sanitiseDeclarations(text)).toBeNull();
  });

  test('keeps balanced functions and non-fixed positions', () => {
    expect(sanitiseDeclarations('width:calc(100% - 2px);position:absolute;left:-3000px')?.css).toBe(
      'width:calc(100% - 2px);position:absolute;left:-3000px',
    );
  });

  test('rejects non-strings and empty blocks', () => {
    expect(sanitiseDeclarations(undefined)).toBeNull();
    expect(sanitiseDeclarations('  ;  ')).toBeNull();
  });
});

describe('sanitiseDeclarations: allowlist', () => {
  test('keeps allowed properties, normalised', () => {
    expect(sanitiseDeclarations('Opacity : 0 !important;  height:0')).toEqual({
      css: 'opacity:0 !important;height:0',
      dropped: [],
    });
  });

  test('drops a declaration whose property is not allowed and keeps the rest', () => {
    expect(sanitiseDeclarations('behavior: x; -moz-binding: y; visibility: hidden')).toEqual({
      css: 'visibility:hidden',
      dropped: ['behavior: x', '-moz-binding: y'],
    });
  });

  test.each([
    ['missing colon', 'opacity 0'],
    ['empty value', 'opacity:'],
    ['custom property', '--x: 1'],
  ])('drops a malformed declaration: %s', (_name, text) => {
    expect(sanitiseDeclarations(`${text}; color: red`)).toEqual({ css: 'color:red', dropped: [text] });
  });

  test('returns null when nothing survives', () => {
    expect(sanitiseDeclarations('content: "x"')).toBeNull();
    expect(sanitiseDeclarations('behavior: x')).toBeNull();
  });

  test('allows no property that can load a resource by itself', () => {
    ['animation', 'background-image', 'list-style-image', 'border-image', 'cursor', 'content', 'mask', 'src', 'behavior'].forEach((p) => {
      expect(ALLOWED_PROPERTIES.has(p)).toBe(false);
    });
  });

  test('output never contains a denied token', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = sanitiseDeclarations(text);
        const lower = result?.css.toLowerCase() ?? '';
        expect(DENIED_DECLARATION_TOKENS.some((token) => lower.includes(token))).toBe(false);
      }),
    );
  });
});
