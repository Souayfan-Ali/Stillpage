import { describe, expect, test } from 'vitest';
import { isSiteHost, isSuffixLike } from '../../../../compiler/entities/hosts.js';

describe('site-host guard (P1-49 review)', () => {
  test.each(['com', 'uk', 'xn--p1ai', 'co.uk', 'com.au', 'gov.br'])('%s is suffix-like', (s) => {
    expect(isSuffixLike(s)).toBe(true);
    expect(isSiteHost(s)).toBe(false);
  });
  test.each(['example.com', 'bbc.co.uk', 'a.b.example.de', 'xn--mnchen-3ya.de'])('%s is a site host', (h) => {
    expect(isSiteHost(h)).toBe(true);
  });
  test.each(['', '*', 'A.COM', 'a..b', '-a.com', '10.0.0.1', 'localhost', 'a.b/c', 'example.123'])('%j is not', (h) => {
    expect(isSiteHost(h)).toBe(false);
  });
});
