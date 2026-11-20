import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { compileAllowlist, compiledText, loadAllowlist, MAX_COMPILED_GZIP_BYTES, matchesAllowlist, MAX_ALLOW_ENTRIES, type AllowEntry } from '../../../../src/core/popup/allowlist.js';
import { isSameSite, siteOf } from '../../../../src/core/popup/site.js';

const gzipBytes = (text: string): number => gzipSync(text).length;
const entry = (over: Partial<AllowEntry> = {}): AllowEntry => ({
  host: 'accounts.google.com', pathPrefix: '/o/oauth2', reviewer: 'owner', source: 'https://developers.google.com/identity/protocols/oauth2', ...over,
});
const load = (entries: readonly unknown[], adHosts: readonly string[] = []) => loadAllowlist(entries, { adHosts: new Set(adHosts), gzipBytes });
const errorsOf = (entries: readonly unknown[], adHosts: readonly string[] = []): readonly string[] => {
  const r = load(entries, adHosts);
  return r.ok ? [] : r.errors;
};

describe('siteOf / isSameSite (last two labels + two-label suffixes)', () => {
  test.each([
    ['news.example.com', 'example.com'],
    ['example.com', 'example.com'],
    ['a.b.example.co.uk', 'example.co.uk'],
    ['shop.example.com.au', 'example.com.au'],
    ['localhost', 'localhost'],
    ['192.168.0.1', '192.168.0.1'],
    ['co.uk', 'co.uk'],
  ])('%s → %s', (host, site) => {
    expect(siteOf(host)).toBe(site);
  });

  test('same-site compares registrable domains', () => {
    expect(isSameSite('a.example.com', 'b.example.com')).toBe(true);
    expect(isSameSite('a.example.co.uk', 'b.other.co.uk')).toBe(false);
  });
});

describe('loadAllowlist: admission lint (pop-up notes §8, design review P2-56)', () => {
  test('accepts first-party endpoints and compiles host → prefixes', () => {
    const r = load([entry(), entry({ pathPrefix: '/signin' }), entry({ host: 'www.paypal.com', pathPrefix: '/checkoutnow', source: 'https://developer.paypal.com/docs' })]);
    expect(r).toEqual({ ok: true, value: { 'accounts.google.com': ['/o/oauth2', '/signin'], 'www.paypal.com': ['/checkoutnow'] } });
  });

  test('a whole host is allowed only when explicit and not the bare site or www', () => {
    expect(load([entry({ host: 'login.microsoftonline.com', pathPrefix: '/', wholeHost: true, source: 'https://learn.microsoft.com/entra' })]).ok).toBe(true);
    expect(errorsOf([entry({ host: 'google.com', pathPrefix: '/', wholeHost: true })])[0]).toMatch(/whole host/);
    expect(errorsOf([entry({ host: 'www.google.com', pathPrefix: '/', wholeHost: true })])[0]).toMatch(/whole host/);
    expect(errorsOf([entry({ pathPrefix: '/' })])[0]).toMatch(/pathPrefix/);
    expect(errorsOf([entry({ wholeHost: true })])[0]).toMatch(/wholeHost/);
  });

  test.each([
    ['open redirector path', { pathPrefix: '/url' }],
    ['redirect segment, any case', { pathPrefix: '/a/Redirect/b' }],
    ['affiliate segment', { pathPrefix: '/aff' }],
    ['query', { pathPrefix: '/o?x' }],
    ['fragment', { pathPrefix: '/o#x' }],
    ['percent escape', { pathPrefix: '/o%2f' }],
    ['dot-dot', { pathPrefix: '/o/../x' }],
    ['double slash', { pathPrefix: '/o//x' }],
    ['trailing slash', { pathPrefix: '/o/' }],
    ['relative', { pathPrefix: 'o' }],
    ['upper-case host', { host: 'Accounts.google.com' }],
    ['non-ASCII host', { host: 'accöunts.google.com' }],
    ['suffix host', { host: 'co.uk', source: 'https://co.uk/' }],
    ['IP host', { host: '10.0.0.1', source: 'https://10.0.0.1/' }],
    ['single label', { host: 'localhost', source: 'https://localhost/' }],
    ['http source', { source: 'http://developers.google.com/x' }],
    ['source on another site', { source: 'https://example.org/google' }],
    ['source not a URL', { source: 'nope' }],
    ['no reviewer', { reviewer: ' ' }],
  ])('refuses %s', (_name, over) => {
    expect(errorsOf([entry(over)]).length).toBeGreaterThan(0);
  });

  test('source aliases: Microsoft docs for microsoftonline.com and linkedin.com, x.com for twitter.com', () => {
    expect(load([entry({ host: 'login.live.com', pathPrefix: '/oauth20_authorize.srf', source: 'https://learn.microsoft.com/x' })]).ok).toBe(true);
    expect(load([entry({ host: 'www.linkedin.com', pathPrefix: '/oauth', source: 'https://learn.microsoft.com/linkedin' })]).ok).toBe(true);
    expect(load([entry({ host: 'api.twitter.com', pathPrefix: '/oauth', source: 'https://docs.x.com/x' })]).ok).toBe(true);
  });

  test('refuses ad hosts, including a listed parent', () => {
    expect(errorsOf([entry({ host: 'pay.adnet.example', source: 'https://adnet.example/' })], ['adnet.example'])[0]).toMatch(/ad host/);
  });

  test('refuses duplicates, too many entries and a compiled form over 1 kB gzip', () => {
    expect(errorsOf([entry(), entry()])[0]).toMatch(/duplicate/);
    const many = Array.from({ length: MAX_ALLOW_ENTRIES + 1 }, (_, i) => entry({ pathPrefix: `/p${String(i)}` }));
    expect(errorsOf(many).join()).toMatch(/at most/);
    const noise = (i: number, n: number): string => createHash('sha256').update(String(i)).digest('hex').slice(0, n);
    const big = Array.from({ length: 60 }, (_, i) => entry({ host: `${noise(i, 20)}.example.com`, pathPrefix: `/${noise(i + 99, 30)}`, source: 'https://example.com/' }));
    expect(errorsOf(big).join()).toMatch(new RegExp(`≤ ${String(MAX_COMPILED_GZIP_BYTES)}`));
  });

  test('refuses malformed input', () => {
    expect(errorsOf(['x'])[0]).toMatch(/entry 0/);
    expect(loadAllowlist('nope', { adHosts: new Set() }).ok).toBe(false);
    expect(errorsOf([{ ...entry(), extra: 1 }])[0]).toMatch(/entry 0/);
  });

  test('without a gzip function the size line is not checked', () => {
    expect(loadAllowlist([entry()], { adHosts: new Set() }).ok).toBe(true);
  });
});

describe('matchesAllowlist and compiledText', () => {
  const compiled = compileAllowlist([{ host: 'accounts.google.com', pathPrefix: '/o/oauth2' }, { host: 'login.microsoftonline.com', pathPrefix: '/' }]);
  test.each([
    ['https://accounts.google.com/o/oauth2', true],
    ['https://accounts.google.com/o/oauth2/v2/auth?client_id=1', true],
    ['https://accounts.google.com/o/oauth2x', false],
    ['https://accounts.google.com/', false],
    ['https://login.microsoftonline.com/tenant/oauth2/authorize', true],
    ['https://x.accounts.google.com/o/oauth2', false],
    ['http://accounts.google.com/o/oauth2', false],
    ['https://accounts.google.com:444/o/oauth2', false],
  ])('%s → %s', (url, expected) => {
    expect(matchesAllowlist(compiled, new URL(url))).toBe(expected);
  });

  test('compiled text is sorted, deterministic JSON', () => {
    expect(compiledText(compileAllowlist([{ host: 'b.example.com', pathPrefix: '/z' }, { host: 'a.example.com', pathPrefix: '/y' }, { host: 'b.example.com', pathPrefix: '/a' }])))
      .toBe('{"a.example.com":["/y"],"b.example.com":["/a","/z"]}');
  });
});
