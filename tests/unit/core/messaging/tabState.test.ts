import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import type { Settings } from '../../../../src/core/state/types.js';
import { settings as settingsOf } from '../reconcile/fixtures.js';
import { EMPTY_USER_FILTERS } from '../../../../src/core/userFilters/store.js';
import { describeTab, grantCoversHost, TabStateSchema, type TabFacts } from '../../../../src/core/messaging/tabState.js';

const NOW = 1_800_000_000_000;
const ALL = { origins: ['<all_urls>'] };
const NONE = { origins: [] };

function facts(over: Partial<TabFacts> = {}): TabFacts {
  return { url: 'https://news.example.com/a?b=1', settings: createDefaultSettings(), grants: ALL, ready: true, settingsReset: false, lastRun: 'ok', packs: [], popupGuard: false, userFilters: EMPTY_USER_FILTERS, now: NOW, ...over };
}

const withSettings = (over: Partial<Settings>): Settings => ({ ...createDefaultSettings(), ...over });

describe('describeTab: the q/tabState answer from what Chrome reports', () => {
  test('an http(s) page with all-sites access: host, default level, access all', () => {
    const state = describeTab(facts());
    expect(state).toEqual({
      page: 'web',
      host: 'news.example.com',
      level: 'standard',
      setOn: null,
      pausedUntil: null,
      access: 'all',
      ready: true,
      settingsReset: false,
      theme: 'system',
      lastRun: 'ok',
      site: { ownLevel: null, popupPolicy: null, pausedUntil: null },
      packs: [],
      popupMode: 'off',
      popupGuard: false,
      hidden: [],
    });
    expect(v.safeParse(TabStateSchema, state).success).toBe(true);
  });

  test('hidden (P2-22, P2-22b): the user filters that apply on the host, its own and its parents’', () => {
    const userFilters = { v: 1, hosts: { 'example.com': ['#a'], 'news.example.com': ['#a', '.b'], 'other.example': ['#c'] } } as unknown as TabFacts['userFilters'];
    const state = describeTab(facts({ userFilters }));
    expect(state.hidden).toEqual(['#a', '.b']);
    expect(v.safeParse(TabStateSchema, state).success).toBe(true);
    expect(describeTab(facts({ userFilters, url: 'chrome://settings' })).hidden).toEqual([]);
  });

  test('hidden (P2-22b): the panel refuses a selector the sanitiser would not leave as it is', () => {
    const state = describeTab(facts());
    for (const bad of ['a{}', ' #a', '', 'x'.repeat(5_000), 7]) {
      expect(v.safeParse(TabStateSchema, { ...state, hidden: [bad] }).success).toBe(false);
    }
    expect(v.safeParse(TabStateSchema, { ...state, hidden: Array.from({ length: 801 }, (_, i) => `#a${String(i)}`) }).success).toBe(false);
  });

  test('inheritance: the effective level is the lowest of the host and its parents', () => {
    const settings = settingsOf({ siteLevels: { 'example.com': 'light', 'news.example.com': 'thorough' } });
    expect(describeTab(facts({ settings }))).toMatchObject({ level: 'light', setOn: 'example.com' });
  });

  test('a pause on a parent: Off with the pause expiry and the pausing host', () => {
    const settings = settingsOf({ pauses: { 'example.com': NOW + 60_000 } });
    expect(describeTab(facts({ settings }))).toMatchObject({ level: 'off', setOn: 'example.com', pausedUntil: NOW + 60_000 });
  });

  test.each([
    ['chrome://settings/'],
    ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html'],
    ['about:blank'],
    ['file:///home/user/a.html'],
    ['view-source:https://example.com/'],
    ['https://chromewebstore.google.com/detail/x/abc'],
    ['https://chrome.google.com/webstore/detail/abc'],
  ])('%s is restricted (Chrome does not let extensions act there)', (url) => {
    expect(describeTab(facts({ url }))).toMatchObject({ page: 'restricted', host: null, access: 'all' });
  });

  test('chrome.google.com outside the store is an ordinary page', () => {
    expect(describeTab(facts({ url: 'https://chrome.google.com/intl/en/' }))).toMatchObject({ page: 'web', host: 'chrome.google.com' });
  });

  test('no address while all sites are granted: a page Chrome hides from every extension (restricted)', () => {
    expect(describeTab(facts({ url: null }))).toMatchObject({ page: 'restricted', host: null });
  });

  test('no address without all-sites access: an ordinary page we may not see; reduced, default level', () => {
    const settings = withSettings({ defaultLevel: 'thorough' });
    expect(describeTab(facts({ url: null, grants: NONE, settings }))).toMatchObject({
      page: 'web',
      host: null,
      level: 'thorough',
      setOn: null,
      access: 'none',
    });
  });

  test.each([
    ['*://news.example.com/*', 'site'],
    ['https://*.example.com/*', 'site'],
    ['https://example.com/*', 'none'],
    ['http://news.example.com/*', 'none'],
    ['*://*/*', 'site'],
    ['https://news.example.com:8443/*', 'site'],
  ] as const)('grant %s on https://news.example.com → access %s', (origin, access) => {
    expect(describeTab(facts({ grants: { origins: [origin] } })).access).toBe(access);
  });

  test('an IP-literal or malformed host gives no host, so the level control is not offered', () => {
    expect(describeTab(facts({ url: 'http://[::1]:8080/' }))).toMatchObject({ page: 'web', host: null });
    expect(describeTab(facts({ url: 'not a url' }))).toMatchObject({ page: 'restricted', host: null });
  });

  test('ready, settings-reset notice and theme are passed through', () => {
    const settings = withSettings({ ui: { theme: 'dark', showBadge: true } });
    expect(describeTab(facts({ ready: false, settingsReset: true, settings }))).toMatchObject({ ready: false, settingsReset: true, theme: 'dark' });
  });
});

describe('grantCoversHost', () => {
  test.each([
    ['<all_urls>', 'https:', 'a.b', true],
    ['*://a.b/*', 'http:', 'a.b', true],
    ['*://a.b/*', 'ftp:', 'a.b', false],
    ['https://*.b/*', 'https:', 'b', true],
    ['https://*.b/*', 'https:', 'xb', false],
    ['https://*/*', 'https:', 'anything.example', true],
    ['https://a.b/path/*', 'https:', 'a.b', true],
    ['garbage', 'https:', 'a.b', false],
  ] as const)('%s covers %s//%s: %s', (pattern, scheme, host, expected) => {
    expect(grantCoversHost([pattern], scheme, host)).toBe(expected);
  });
});

describe('packs and pop-up mode for the report (P2-15)', () => {
  test('passed through; the schema refuses an invalid pack id', () => {
    const state = describeTab(facts({ packs: ['ads', 'cookies'] as never }));
    expect(state).toMatchObject({ packs: ['ads', 'cookies'], popupMode: 'off' });
    expect(v.safeParse(TabStateSchema, { ...state, packs: ['Bad Pack'] }).success).toBe(false);
  });
});
