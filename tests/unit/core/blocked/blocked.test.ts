import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { decideBlockedPage, type Situation } from '../../../../src/core/blocked/decide.js';
import { MAX_FRAGMENT_LENGTH, parseBlockedFragment, senderHost } from '../../../../src/core/blocked/fragment.js';
import { isProceedOnceRule, PROCEED_ONCE_ID_RANGE, proceedOnceRule } from '../../../../src/core/blocked/proceed.js';
import type { Hostname } from '../../../../src/core/ids.js';
import { POPUP_PRIORITY } from '../../../../src/core/limits.js';

/** 2,000 fuzz runs take ≈ 1 s on a quiet machine; the default 5 s is too tight while other test runs share the machine. */
const FUZZ_TIMEOUT_MS = 30_000;

describe('decideBlockedPage: pop-up notes §6.2 table, closing only on a positive signal (design review, P2-58)', () => {
  const at = (s: Partial<Situation>): Situation => ({ historyLength: 1, hasOpener: false, openerReportsScriptOpen: false, openerReportsLinkClick: false, ...s });
  test.each([
    ['fresh tab a page script opened (opener confirms) → closes itself', at({ hasOpener: true, openerReportsScriptOpen: true }), { kind: 'close' }],
    ['user-opened tab with an opener id but no confirmation (Ctrl+T, bookmark, guard off) → stays', at({ hasOpener: true }), { kind: 'stay', primary: 'close-tab', reason: 'listed' }],
    ['a link the user clicked → stays with the link line', at({ hasOpener: true, openerReportsLinkClick: true }), { kind: 'stay', primary: 'close-tab', reason: 'link' }],
    ['a script open and a link click both reported: the click wins, stays', at({ hasOpener: true, openerReportsScriptOpen: true, openerReportsLinkClick: true }), { kind: 'stay', primary: 'close-tab', reason: 'link' }],
    ['fresh tab without opener (typed, bookmark) → stays', at({}), { kind: 'stay', primary: 'close-tab', reason: 'listed' }],
    ['a script report without an opener id never closes', at({ openerReportsScriptOpen: true }), { kind: 'stay', primary: 'close-tab', reason: 'listed' }],
    ['existing tab → stays, Go back first', at({ historyLength: 3, hasOpener: true, openerReportsScriptOpen: true }), { kind: 'stay', primary: 'go-back', reason: 'listed' }],
  ] as const)('%s', (_name, situation, expected) => {
    expect(decideBlockedPage(situation)).toEqual(expected);
  });
});

describe('parseBlockedFragment: the fragment is hostile input', () => {
  test.each([
    ['#https://ad.example.net/landing?x=1', 'https://ad.example.net/landing?x=1', 'ad.example.net'],
    ['#http://AD.Example.NET:8080/p', 'http://ad.example.net:8080/p', 'ad.example.net'],
    ['https://ad.example.net/', 'https://ad.example.net/', 'ad.example.net'],
    ['#https://ad.example.net/a#b', 'https://ad.example.net/a#b', 'ad.example.net'],
  ])('%s', (hash, url, host) => {
    expect(parseBlockedFragment(hash)).toEqual({ url, host });
  });

  test.each([
    [''], ['#'], ['#javascript:alert(1)'], ['#data:text/html,<b>x</b>'], ['#chrome://settings'], ['#chrome-extension://abc/popup.html'],
    ['#/relative'], ['#https://'], ['#https://user:pw@ad.example.net/'], ['#https://[::1]/'], ['#ftp://ad.example.net/'],
    ['#file:///etc/passwd'], ['#https://ad.example.net/' + 'a'.repeat(MAX_FRAGMENT_LENGTH)], ['#  https://ad.example.net/'],
  ])('refuses %j', (hash) => {
    expect(parseBlockedFragment(hash)).toBeNull();
  });

  test.each([['#HTTP://u:p@evil.com/'], ['#http:\\\\evil.com/'], ['#http://evil.com./'], ['#http://[::1]/']])('refuses %j (review LOW-4)', (hash) => {
    expect(parseBlockedFragment(hash)).toBeNull();
  });

  test('percent-encoded host labels are decoded by the URL parser and shown canonical', () => {
    expect(parseBlockedFragment('#http://ex%61mple.com/')).toEqual({ url: 'http://example.com/', host: 'example.com' });
  });

  test('a fragment of exactly the maximum length is accepted', () => {
    const base = '#https://ad.example.net/';
    const hash = `${base}${'a'.repeat(MAX_FRAGMENT_LENGTH - base.length + 1)}`;
    expect(hash.length - 1).toBe(MAX_FRAGMENT_LENGTH);
    expect(parseBlockedFragment(hash)?.host).toBe('ad.example.net');
  });

  test('fuzz: never throws; anything accepted is an absolute http(s) URL whose host is a plain hostname', () => {
    fc.assert(fc.property(fc.oneof(fc.string(), fc.webUrl().map((u) => `#${u}`), fc.string().map((s) => `#https://${s}`)), (hash) => {
      const r = parseBlockedFragment(hash);
      if (r === null) return true;
      const u = new URL(r.url);
      return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname === r.host && /^[a-z0-9._-]+$/.test(r.host) && u.username === '' && u.password === '';
    }), { numRuns: 2_000 });
  }, FUZZ_TIMEOUT_MS);

  test('senderHost: the referrer’s hostname, or null', () => {
    expect(senderHost('https://news.example.com/article')).toBe('news.example.com');
    expect(senderHost('')).toBeNull();
    expect(senderHost('chrome-extension://x/')).toBeNull();
    expect(senderHost('not a url')).toBeNull();
  });
});

describe('proceedOnceRule (for the worker’s c/proceedOnce handler)', () => {
  const host = 'ad.example.net' as Hostname;
  test('one session allow rule for that host in that tab, above the redirect and the block', () => {
    expect(proceedOnceRule(host, 42, [])).toEqual({
      id: PROCEED_ONCE_ID_RANGE.min, priority: POPUP_PRIORITY.allow, action: { type: 'allow' },
      condition: { requestDomains: [host], tabIds: [42], resourceTypes: ['main_frame'] },
    });
    expect(POPUP_PRIORITY.allow).toBeGreaterThan(POPUP_PRIORITY.redirect);
  });

  test('takes the lowest free id in the session range; null when full or the tab id is invalid', () => {
    expect(proceedOnceRule(host, 1, [1, 2, 4])?.id).toBe(3);
    const full = Array.from({ length: PROCEED_ONCE_ID_RANGE.max - PROCEED_ONCE_ID_RANGE.min + 1 }, (_, i) => PROCEED_ONCE_ID_RANGE.min + i);
    expect(proceedOnceRule(host, 1, full)).toBeNull();
    expect(proceedOnceRule(host, -1, [])).toBeNull();
    expect(proceedOnceRule(host, 1.5, [])).toBeNull();
  });

  test('isProceedOnceRule: exact shape inside the range only (what the reconciler carries through)', () => {
    const rule = proceedOnceRule(host, 7, []);
    if (rule === null) throw new Error('no rule');
    expect(isProceedOnceRule(rule)).toBe(true);
    expect(isProceedOnceRule({ ...rule, id: 1_000 })).toBe(false);
    expect(isProceedOnceRule({ ...rule, priority: 2 })).toBe(false);
    expect(isProceedOnceRule({ ...rule, action: { type: 'block' } })).toBe(false);
    expect(isProceedOnceRule({ ...rule, condition: { ...rule.condition, tabIds: [] } })).toBe(false);
    expect(isProceedOnceRule({ ...rule, condition: { ...rule.condition, regexFilter: '.*' } })).toBe(false);
    expect(isProceedOnceRule({ ...rule, condition: { ...rule.condition, resourceTypes: ['main_frame', 'sub_frame'] } })).toBe(false);
  });
});
