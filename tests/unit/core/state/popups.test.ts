import { describe, expect, test } from 'vitest';
import type { Hostname } from '../../../../src/core/ids.js';
import { MAX_SITES_PER_LEVEL } from '../../../../src/core/limits.js';
import { parseHostList, parseLiftedList } from '../../../../src/core/reconcile/popupLists.js';
import { createDefaultSettings, POPUP_LIST_STRICT_DEFAULT } from '../../../../src/core/state/defaults.js';
import { withPopupMode, withSitePopupPolicy } from '../../../../src/core/state/popups.js';

const host = (h: string): Hostname => h as Hostname;

describe('pop-up settings changes (P2-54)', () => {
  test('mode and site policy return new objects; inherit removes the site', () => {
    const base = createDefaultSettings();
    const strict = withPopupMode(base, 'strict');
    const allowed = withSitePopupPolicy(strict, host('a.com'), 'allow');
    expect(strict.popups).toEqual({ mode: 'strict', sites: {}, notice: true });
    expect(allowed?.popups.sites).toEqual({ 'a.com': 'allow' });
    expect(withSitePopupPolicy(allowed ?? base, host('a.com'), 'inherit')?.popups.sites).toEqual({});
    expect(base.popups.mode).toBe('off');
  });

  test('a new site beyond the cap is refused (null); changing an existing one is not', () => {
    const sites = Object.fromEntries(Array.from({ length: MAX_SITES_PER_LEVEL }, (_, i) => [`s${String(i)}.com`, 'allow' as const]));
    const full = { ...createDefaultSettings(), popups: { ...createDefaultSettings().popups, sites } };
    expect(withSitePopupPolicy(full, host('new.com'), 'strict')).toBeNull();
    expect(withSitePopupPolicy(full, host('s1.com'), 'strict')?.popups.sites['s1.com' as Hostname]).toBe('strict');
  });

  test('list-designated Strict sites are on by default (design review, 2026-11-14; owner may turn them off)', () => {
    expect(POPUP_LIST_STRICT_DEFAULT).toBe(true);
  });
});

describe('packaged pop-up host lists', () => {
  test('a JSON array of canonical hostnames, else null', () => {
    expect(parseHostList('["a.com","b.example"]')).toEqual(['a.com', 'b.example']);
    expect(parseHostList('[]')).toEqual([]);
    expect(parseHostList('["A.com"]')).toBeNull();
    expect(parseHostList('{"a":1}')).toBeNull();
    expect(parseHostList('[1]')).toBeNull();
    expect(parseHostList('not json')).toBeNull();
  });

  test('popup-lifted.json (D-55a): ruleset id → canonical hostnames, else null', () => {
    expect(parseLiftedList('{"ubo":["a-ads.com"],"easylist":[]}')).toEqual({ ubo: ['a-ads.com'], easylist: [] });
    expect(parseLiftedList('{}')).toEqual({});
    expect(parseLiftedList('["a-ads.com"]')).toBeNull();
    expect(parseLiftedList('{"ubo":["A.com"]}')).toBeNull();
    expect(parseLiftedList('{"Not An Id":[]}')).toBeNull();
    expect(parseLiftedList('{"__proto__":["a.com"]}')).toBeNull();
    expect(parseLiftedList('null')).toBeNull();
    expect(parseLiftedList('not json')).toBeNull();
  });
});
