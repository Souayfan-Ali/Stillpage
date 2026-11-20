/**
 * P2-29: the language suggestion is computed locally from the browser UI language
 * (`chrome.i18n.getUILanguage()`, UI notes onboarding step 2, ADR-015 item 3); only packs this build ships.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { PackId } from '../../../../src/core/ids.js';
import { suggestRegionalPacks } from '../../../../src/core/reconcile/regional.js';

const all = ['ads', 'reg-de', 'reg-it', 'reg-ja', 'reg-nl', 'reg-zh', 'reg-es-pt'] as PackId[];

describe('suggestRegionalPacks', () => {
  test.each([
    [['de-DE'], ['reg-de']], [['de-AT'], ['reg-de']], [['it'], ['reg-it']], [['ja'], ['reg-ja']], [['nl-BE'], ['reg-nl']],
    [['zh-CN'], ['reg-zh']], [['zh-TW'], ['reg-zh']], [['es-419'], ['reg-es-pt']], [['pt-BR'], ['reg-es-pt']], [['PT'], ['reg-es-pt']],
    [['en-US'], []], [['fr'], []], [['ru'], []], [[''], []], [['es', 'pt'], ['reg-es-pt']], [['de', 'en', 'it'], ['reg-de', 'reg-it']],
  ])('%j → %j', (languages, expected) => {
    expect(suggestRegionalPacks(languages, all)).toEqual(expected);
  });

  test('only packs present in this build (the store build drops zh and es/pt)', () => {
    const store = all.filter((p) => p !== 'reg-zh' && p !== 'reg-es-pt');
    expect(suggestRegionalPacks(['zh-CN'], store)).toEqual([]);
    expect(suggestRegionalPacks(['pt-BR'], store)).toEqual([]);
    expect(suggestRegionalPacks(['de'], store)).toEqual(['reg-de']);
  });

  test('never throws and only returns catalog packs, whatever the input', () => {
    fc.assert(fc.property(fc.array(fc.string()), (languages) => {
      expect(suggestRegionalPacks(languages, all).every((p) => all.includes(p))).toBe(true);
    }));
  });
});
