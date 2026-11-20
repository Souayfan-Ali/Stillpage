import { describe, expect, test } from 'vitest';
import {
  isProceedOnceRule,
  liftedProceedOnceRule,
  liftedProceedUrl,
  PROCEED_ONCE_ID_RANGE,
  proceedOnceHost,
  proceedOnceRule,
} from '../../../../src/core/blocked/proceed.js';
import type { Hostname } from '../../../../src/core/ids.js';
import { POPUP_LIFT_PRIORITY, PROCEED_ONCE_URL_MAX_CHARS } from '../../../../src/core/limits.js';

/** D-55 / D-55a: "Proceed once" on a lifted host covers one exact URL in one tab, at 5,000,001. */
const host = 'a-ads.com' as Hostname;

describe('liftedProceedUrl', () => {
  test('the canonical address without its fragment', () => {
    expect(liftedProceedUrl('https://a-ads.com/landing?x=1#frag', host)).toBe('https://a-ads.com/landing?x=1');
    expect(liftedProceedUrl('http://A-ADS.com/', host)).toBe('http://a-ads.com/');
  });

  test('refuses another host, a subdomain, credentials, non-web schemes and unparsable text', () => {
    expect(liftedProceedUrl('https://other.example/', host)).toBeNull();
    expect(liftedProceedUrl('https://sub.a-ads.com/', host)).toBeNull();
    expect(liftedProceedUrl('https://u:p@a-ads.com/', host)).toBeNull();
    expect(liftedProceedUrl('ftp://a-ads.com/', host)).toBeNull();
    expect(liftedProceedUrl('javascript:alert(1)', host)).toBeNull();
    expect(liftedProceedUrl('not a url', host)).toBeNull();
  });

  test('refuses URL-filter syntax (* ^ |) and anything that is not printable ASCII after serialisation', () => {
    expect(liftedProceedUrl('https://a-ads.com/a*b', host)).toBeNull();
    expect(liftedProceedUrl('https://a-ads.com/a^b', host)).toBeNull();
    expect(liftedProceedUrl('https://a-ads.com/a|b', host)).toBeNull();
    // Non-ASCII is percent-encoded by the URL parser, so it is accepted in its encoded form.
    expect(liftedProceedUrl('https://a-ads.com/é', host)).toBe('https://a-ads.com/%C3%A9');
  });

  test('refuses an address longer than PROCEED_ONCE_URL_MAX_CHARS', () => {
    const base = 'https://a-ads.com/?q=';
    expect(liftedProceedUrl(base + 'a'.repeat(PROCEED_ONCE_URL_MAX_CHARS - base.length), host)).not.toBeNull();
    expect(liftedProceedUrl(base + 'a'.repeat(PROCEED_ONCE_URL_MAX_CHARS - base.length + 1), host)).toBeNull();
  });
});

describe('liftedProceedOnceRule', () => {
  test('one exact-URL allow in that tab, scoped to the host, above the lifted redirect', () => {
    expect(liftedProceedOnceRule('https://a-ads.com/landing', host, 42, [])).toEqual({
      id: PROCEED_ONCE_ID_RANGE.min,
      priority: POPUP_LIFT_PRIORITY.allow,
      action: { type: 'allow' },
      condition: {
        urlFilter: '|https://a-ads.com/landing|',
        isUrlFilterCaseSensitive: true,
        requestDomains: [host],
        tabIds: [42],
        resourceTypes: ['main_frame'],
      },
    });
  });

  test('null when the URL is refused, the range is full or the tab id is invalid', () => {
    expect(liftedProceedOnceRule('https://other.example/', host, 1, [])).toBeNull();
    const full = Array.from({ length: PROCEED_ONCE_ID_RANGE.max - PROCEED_ONCE_ID_RANGE.min + 1 }, (_, i) => PROCEED_ONCE_ID_RANGE.min + i);
    expect(liftedProceedOnceRule('https://a-ads.com/', host, 1, full)).toBeNull();
    expect(liftedProceedOnceRule('https://a-ads.com/', host, -1, [])).toBeNull();
  });
});

describe('isProceedOnceRule accepts both shapes and nothing else', () => {
  const lifted = liftedProceedOnceRule('https://a-ads.com/landing', host, 7, []);
  const plain = proceedOnceRule(host, 7, []);
  if (lifted === null || plain === null) throw new Error('no rule');

  test('host + tab at 3, exact URL + tab at 5,000,001', () => {
    expect(isProceedOnceRule(plain)).toBe(true);
    expect(isProceedOnceRule(lifted)).toBe(true);
    expect(proceedOnceHost(plain)).toBe(host);
    expect(proceedOnceHost(lifted)).toBe(host);
  });

  test('a host-wide rule at the lift priority, or a URL rule at 3, is refused', () => {
    expect(isProceedOnceRule({ ...plain, priority: POPUP_LIFT_PRIORITY.allow })).toBe(false);
    expect(isProceedOnceRule({ ...lifted, priority: 3 })).toBe(false);
  });

  test('a lifted rule must stay exact, case-sensitive and on its host', () => {
    const c = lifted.condition;
    expect(isProceedOnceRule({ ...lifted, condition: { ...c, isUrlFilterCaseSensitive: false } })).toBe(false);
    expect(isProceedOnceRule({ ...lifted, condition: { ...c, urlFilter: '||a-ads.com^' } })).toBe(false);
    expect(isProceedOnceRule({ ...lifted, condition: { ...c, urlFilter: '|https://a-ads.com/*|' } })).toBe(false);
    expect(isProceedOnceRule({ ...lifted, condition: { ...c, urlFilter: '|https://evil.example/|' } })).toBe(false);
    expect(isProceedOnceRule({ ...lifted, condition: { ...c, requestDomains: ['com'] } })).toBe(false);
    expect(isProceedOnceRule({ ...lifted, condition: { ...c, tabIds: [] } })).toBe(false);
    expect(isProceedOnceRule({ ...lifted, condition: { ...c, initiatorDomains: ['x.example'] } })).toBe(false);
    expect(isProceedOnceRule({ ...lifted, id: PROCEED_ONCE_ID_RANGE.max + 1 })).toBe(false);
  });

  test('a host + tab rule with a URL filter is refused', () => {
    expect(isProceedOnceRule({ ...plain, condition: { ...plain.condition, urlFilter: '|https://a-ads.com/|' } })).toBe(false);
  });
});
