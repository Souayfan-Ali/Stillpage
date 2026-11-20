import { describe, expect, test } from 'vitest';
import { englishCatalog, resolveMessage } from '../../helpers/chromeI18n.js';
import { EXPANSION, pseudoCatalog, textLength } from '../../helpers/pseudoLocale.js';

const english = englishCatalog();
const copyKeys = Object.keys(english).filter((k) => !k.startsWith('meta_') && k !== 'ext_description' && k !== 'command_hide_element');

describe('pseudo-locales for the layout tests (P2-40)', () => {
  test('long: every message accented, bracketed and at least 40 % longer; substitutions still land', () => {
    const long = pseudoCatalog(english, 'long');
    for (const key of copyKeys) {
      const before = english[key]?.message ?? '';
      const after = long[key]?.message ?? '';
      expect(after.startsWith('[') && after.endsWith(']'), key).toBe(true);
      expect(textLength(after), key).toBeGreaterThanOrEqual(textLength(before) * (1 + EXPANSION));
      expect(after.replace(/\$[A-Za-z0-9_]+\$/g, ''), key).not.toMatch(/[A-Za-z]/);
    }
    expect(resolveMessage(long, 'panel_capped', ['a.example'])).toMatch(/^\[Šéţ óñ a\.example\. .* a\.example\. .*\]$/);
    expect(long['meta_lang']?.message).toBe('en-XA');
    expect(long['meta_dir']?.message).toBe('ltr');
  });

  test('rtl: right-to-left words and catalog direction; placeholders untouched', () => {
    const rtl = pseudoCatalog(english, 'rtl');
    expect(rtl['meta_dir']?.message).toBe('rtl');
    expect(rtl['meta_lang']?.message).toBe('ar');
    expect(resolveMessage(rtl, 'row_open', ['news.example'])).toBe('‮Open‬ news.example');
    for (const key of copyKeys) expect(rtl[key]?.message, key).toContain('‮');
  });

  test('the manifest messages stay English (Chrome checks them at load), and the input is not changed', () => {
    const snapshot = JSON.stringify(english);
    const long = pseudoCatalog(english, 'long');
    expect(long['ext_description']).toEqual(english['ext_description']);
    expect(JSON.stringify(english)).toBe(snapshot);
  });
});
