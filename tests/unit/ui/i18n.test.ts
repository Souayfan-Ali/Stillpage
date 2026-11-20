import { afterEach, describe, expect, test } from 'vitest';
import { applyDocumentLocale, formatNumber, plural, pluralKey, t, uiDirection, uiLocale } from '../../../src/ui/i18n.js';
import { createI18n, resolveMessage, type Catalog } from '../../helpers/chromeI18n.js';

const scope = globalThis as { chrome?: object | undefined };
const shipped = scope.chrome;

function useCatalog(catalog: Catalog | null): void {
  scope.chrome = catalog === null ? undefined : { i18n: createI18n(catalog) };
}

afterEach(() => {
  scope.chrome = shipped;
});

describe('the Chrome lookup used by the tests', () => {
  const catalog: Catalog = {
    two: { message: 'Set on $HOST$, not $Other$; $$5', placeholders: { host: { content: '$1' }, other: { content: '$2' } } },
    raw: { message: 'Raw $1 and $2' },
  };

  test('named placeholders, positional substitutions, $$ and unknown keys', () => {
    expect(resolveMessage(catalog, 'two', ['a.example', 'b.example'])).toBe('Set on a.example, not b.example; $5');
    expect(resolveMessage(catalog, 'raw', 'x')).toBe('Raw x and ');
    expect(resolveMessage(catalog, 'nope')).toBe('');
  });
});

describe('t and the locale of the catalog (P2-40)', () => {
  test('reads the shipped English catalog', () => {
    expect(t('common_loading')).toBe('Loading…');
    expect(t('panel_capped', 'example.com')).toBe('Set on example.com. A site cannot be set higher than example.com.');
    expect(uiLocale()).toBe('en-GB');
    expect(uiDirection()).toBe('ltr');
  });

  test('falls back to the key when the catalog has no such message or chrome.i18n is missing', () => {
    useCatalog({});
    expect(t('common_loading')).toBe('common_loading');
    useCatalog(null);
    expect(t('common_loading')).toBe('common_loading');
    expect(uiLocale()).toBe('en');
    expect(uiDirection()).toBe('ltr');
  });

  test('an RTL catalog sets dir and lang on the page root', () => {
    useCatalog({ meta_lang: { message: 'ar' }, meta_dir: { message: 'rtl' } });
    const root = { lang: '', dir: '' };
    applyDocumentLocale({ documentElement: root } as unknown as Document);
    expect(root).toEqual({ lang: 'ar', dir: 'rtl' });
  });

  test('an unknown direction reads as ltr', () => {
    useCatalog({ meta_dir: { message: 'sideways' } });
    expect(uiDirection()).toBe('ltr');
  });

  test('plurals follow the catalog locale and format the count', () => {
    expect(pluralKey(1, 'common_sites_one', 'common_sites_other')).toBe('common_sites_one');
    expect(plural(1, 'common_sites_one', 'common_sites_other')).toBe('1 site');
    expect(plural(0, 'common_sites_one', 'common_sites_other')).toBe('0 sites');
    expect(plural(1200, 'common_sites_one', 'common_sites_other')).toBe('1,200 sites');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});
