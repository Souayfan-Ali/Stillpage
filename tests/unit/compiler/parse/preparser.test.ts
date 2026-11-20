import { describe, expect, test } from 'vitest';
import { evalExpression, preparse, UBOL_CHROMIUM_ENV } from '../../../../compiler/parse/preparser.js';

const lines = (text: string) => preparse(text).lines.map((l) => l.text);

describe('preparser with the uBOL Chromium environment (S-02a)', () => {
  test('the environment is exactly uBOL\'s', () => {
    expect(UBOL_CHROMIUM_ENV).toEqual(['chromium', 'native_css_has', 'mv3', 'ublock', 'ubol']);
  });

  test.each([
    ['ext_ubol', true], ['ext_ublock', true], ['env_chromium', true], ['env_mv3', true],
    ['adguard_ext_chromium', true], ['adguard_ext_chromium_mv3', true], ['adguard_ext_opera', true],
    ['env_firefox', false], ['env_safari', false], ['env_mobile', false], ['ext_abp', false], ['adguard', false],
    ['cap_html_filtering', false], ['cap_ipaddress', false], ['cap_anything_new', false],
    ['!env_firefox', true], ['!ext_ubol', false], ['!false', true], ['!cap_html_filtering', true],
    ['env_chromium && !env_mobile', true], ['env_firefox || env_chromium', true], ['(env_firefox || env_safari)', false],
  ])('%s → %s', (expr, value) => {
    expect(evalExpression(expr, UBOL_CHROMIUM_ENV)).toBe(value);
  });

  test.each(['unknown_token', '&& env_mv3', 'env_mv3 ^^ env_chromium', 'env_mv3 && unknown', 'env_mv3 &&  ', ''])(
    'unknown or malformed expression %j is undefined',
    (expr) => {
      expect(evalExpression(expr, UBOL_CHROMIUM_ENV)).toBeUndefined();
    },
  );

  test('keeps true branches, drops false ones, honours else and nesting, keeps line numbers', () => {
    const text = ['a', '!#if env_firefox', 'ff', '!#else', 'not-ff', '!#if cap_html_filtering', 'html', '!#endif', '!#endif', 'z'].join('\n');
    const r = preparse(text);
    expect(r.lines).toEqual([{ line: 1, text: 'a' }, { line: 5, text: 'not-ff' }, { line: 10, text: 'z' }]);
    expect(r.ifBlocks).toBe(2);
    expect(r.discardedLines).toBe(2);
  });

  test('an unknown expression keeps its block (uBO semantics)', () => {
    expect(lines('!#if env_brand_new\nkept\n!#else\nalso\n!#endif')).toEqual(['kept', 'also']);
  });

  test('stray else/endif are ignored; CRLF input is split; includes are reported, not resolved', () => {
    expect(lines('!#endif\r\n!#else\r\nx')).toEqual(['x']);
    expect(preparse('!#include other.txt\ny').includes).toEqual([{ line: 1, text: '!#include other.txt' }]);
    expect(preparse('!#if false\n!#include other.txt\n!#endif').includes).toEqual([]);
  });
});
