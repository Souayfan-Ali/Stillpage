/**
 * D-72: the publish job's dependency-free checker rejects suffix-level breadth (`||com^`, `co.uk`) like
 * `compiler/verify` does, and is a strict superset of verify's breadth check (the last trusted gate is never
 * weaker than the untrusted one).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { isSuffixLike as compilerIsSuffixLike } from '../../../../compiler/entities/hosts.js';
import { isSuffixLike, rulesetProblems } from '../../../../compiler/store/candidate/rules.js';
import { verifyArtefacts } from '../../../../compiler/verify/verify.js';
import { b, built, UBO } from '../verify/helpers.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** Problems of a one-rule ruleset judged against itself (no growth). */
const problemsOf = (rule: object): readonly string[] => {
  const bytes = enc(JSON.stringify([{ id: 1, ...rule }]));
  return rulesetProblems('rulesets/ubo.json', bytes, bytes);
};
const isRejected = (rule: object): boolean => problemsOf(rule).some((p) => p.includes('catch-all'));

describe('isSuffixLike port (D-72)', () => {
  const corpus = ['com', 'uk', 'top', 'xn--p1ai', 'xn--', 'co.uk', 'com.au', 'ne.jp', 'gov.br', 'a.co.uk', 'example.com', 'co.com',
    'com.example', 'a.b', '1.2.3.4', '127.0.0.1', '', '.', 'com.', '.com', 'COM', 'x', 'a1', 'localhost', 'sch.uk', 'org.uk.example'];
  test.each(corpus)('%j equals compiler/entities/hosts.ts', (s) => {
    expect(isSuffixLike(s)).toBe(compilerIsSuffixLike(s));
  });
});

describe('suffix-level catch-alls in a changed safe ruleset (D-72)', () => {
  test.each([
    ['an allow of a whole TLD', { action: { type: 'allow' }, condition: { urlFilter: '||com^' } }],
    ['an allow of a ccSLD', { action: { type: 'allow' }, condition: { urlFilter: '||co.uk^' } }],
    ['an upper-case suffix (urlFilter is case-insensitive)', { action: { type: 'allow' }, condition: { urlFilter: '||COM^' } }],
    ['a suffix with a scheme anchor', { action: { type: 'allowAllRequests' }, condition: { urlFilter: '|https://com.au^', resourceTypes: ['main_frame'] } }],
    ['a main_frame block of a suffix', { action: { type: 'block' }, condition: { urlFilter: '||co.uk^', resourceTypes: ['main_frame'] } }],
    ['a main_frame block by requestDomains suffix', { action: { type: 'block' }, condition: { requestDomains: ['com'], resourceTypes: ['main_frame', 'script'] } }],
    ['request domains that include a suffix', { action: { type: 'allow' }, condition: { requestDomains: ['a.example', 'co.uk'] } }],
    ['initiator domains that include a suffix', { action: { type: 'allowAllRequests' }, condition: { initiatorDomains: ['com'], resourceTypes: ['main_frame'] } }],
    ['excluded domains do not narrow', { action: { type: 'allow' }, condition: { urlFilter: '||com^', excludedRequestDomains: ['a.com'], excludedInitiatorDomains: ['b.com'] } }],
    ['topDomains do not narrow', { action: { type: 'allow' }, condition: { urlFilter: '||com^', topDomains: ['a.example'] } }],
    // Security review (MEDIUM 1): wildcard / dot prefixes, trailing dots, ports and paths after a suffix.
    ['a wildcard subdomain of a TLD', { action: { type: 'allow' }, condition: { urlFilter: '||*.com^' } }],
    ['an unanchored wildcard subdomain', { action: { type: 'allow' }, condition: { urlFilter: '*.com^' } }],
    ['a leading dot', { action: { type: 'allow' }, condition: { urlFilter: '||.com^' } }],
    ['a scheme and a wildcard ccSLD', { action: { type: 'allowAllRequests' }, condition: { urlFilter: '|https://*.co.uk^', resourceTypes: ['main_frame'] } }],
    ['a trailing dot', { action: { type: 'allow' }, condition: { urlFilter: '||com.^' } }],
    ['a port', { action: { type: 'allow' }, condition: { urlFilter: '||com:443^' } }],
    ['a separator and a path wildcard', { action: { type: 'allow' }, condition: { urlFilter: '||com/*' } }],
    // Security review (MEDIUM 2): a regex that names only a suffix.
    ['a regex naming only a TLD', { action: { type: 'allowAllRequests' }, condition: { regexFilter: '^https?://[^/]*\\.com/', resourceTypes: ['main_frame'] } }],
    ['an allow regex naming only a ccSLD', { action: { type: 'allow' }, condition: { regexFilter: '\\.co\\.uk' } }],
  ])('%s → abort', (_name, rule) => {
    expect(problemsOf(rule)).toEqual([expect.stringMatching(/^rulesets\/ubo\.json: rule 1 is a catch-all "\w+" that names no site$/)]);
  });

  test.each([
    ['a site under a suffix', { action: { type: 'allow' }, condition: { urlFilter: '||a.co.uk^' } }],
    ['a site that ends like a suffix', { action: { type: 'allow' }, condition: { urlFilter: '||example.com^' } }],
    ['a path under a suffix', { action: { type: 'allow' }, condition: { urlFilter: '||com^/x.js' } }],
    ['a suffix request domain with a site-naming URL filter', { action: { type: 'block' }, condition: { requestDomains: ['top'], urlFilter: '&p=*&_mi|', resourceTypes: ['main_frame'] } }],
    ['a site-scoped initiator', { action: { type: 'allow' }, condition: { urlFilter: '||com^', initiatorDomains: ['site.example'], requestDomains: ['site.example'] } }],
    ['a broad block of scripts (not main_frame)', { action: { type: 'block' }, condition: { urlFilter: '||com^', resourceTypes: ['script'] } }],
    ['a wildcard subdomain of a site', { action: { type: 'allow' }, condition: { urlFilter: '||*.example.com^' } }],
    ['a site with a port', { action: { type: 'allow' }, condition: { urlFilter: '||a.example:8080/' } }],
    ['an IPv4 host', { action: { type: 'allow' }, condition: { urlFilter: '||192.168.1.1^' } }],
    ['a host with a wildcard TLD', { action: { type: 'allow' }, condition: { urlFilter: '||kinepolis.*/js/smart-app-banner.js', domainType: 'firstParty' } }],
    ['a label prefix', { action: { type: 'block' }, condition: { urlFilter: '||revancedapk.', resourceTypes: ['main_frame'], excludedRequestDomains: ['revanced.app'] } }],
    ['a page block with a site regex scoped by a TLD (badware)', { action: { type: 'block' }, condition: { regexFilter: '^https:\\/\\/steam\\.(?:community)?workshop-?[a-z]+\\.com\\/', requestDomains: ['com'], resourceTypes: ['main_frame'] } }],
    ['a path-only allow regex (cookies)', { action: { type: 'allow' }, condition: { regexFilter: 'complianz-gdpr-premium/cookiebanner', domainType: 'firstParty', resourceTypes: ['script'] } }],
    ['a path on any http host (reg-ja)', { action: { type: 'block' }, condition: { urlFilter: '|http://*/j/mmenu.php', resourceTypes: ['main_frame'] } }],
    ['a regex naming a site', { action: { type: 'allowAllRequests' }, condition: { regexFilter: '^https://(www\\.)?a\\.example/', resourceTypes: ['main_frame'] } }],
  ])('%s passes', (_name, rule) => {
    expect(problemsOf(rule)).toEqual([]);
  });
});

describe('the checker is a strict superset of verify\'s breadth check (D-72)', () => {
  const P = 110;
  const corpus: readonly Omit<DnrRule, 'id'>[] = [
    { priority: P, action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['main_frame'], urlFilter: '*' } },
    { priority: P, action: { type: 'allow' }, condition: { urlFilter: '||com^' } },
    { priority: P, action: { type: 'allow' }, condition: { domainType: 'thirdParty' } },
    { priority: P, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], urlFilter: '||co.uk^' } },
    { priority: P, action: { type: 'block' }, condition: { resourceTypes: ['main_frame', 'script'], requestDomains: ['com'] } },
    { priority: P, action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['main_frame'], initiatorDomains: ['com'] } },
    { priority: P, action: { type: 'allow' }, condition: { urlFilter: '|https://', requestDomains: ['a.example', 'com.au'] } },
    { priority: P, action: { type: 'allow' }, condition: { urlFilter: '/wp-content/plugins/x.js' } },
    { priority: P, action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['main_frame'], urlFilter: '||site.example^' } },
    { priority: P, action: { type: 'allow' }, condition: { initiatorDomains: ['site.example'] } },
    { priority: P, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], requestDomains: ['top'], urlFilter: '&p=*&_mi|' } },
    { priority: P, action: { type: 'block' }, condition: { resourceTypes: ['ping'], domainType: 'thirdParty', urlFilter: '*' } },
  ];
  test.each(corpus.map((r, i) => [i, r] as const))('rule %i: verify broad ⇒ checker rejects', async (_i, rule) => {
    const failures = verifyArtefacts(await built({ ubo: [...UBO, b(rule)] })).failures;
    const verifyBroad = failures.some((f) => f.includes('allow every host or a whole suffix'));
    if (verifyBroad) expect(isRejected(rule)).toBe(true);
  });
  test('the corpus is not vacuous: verify flags its first 7 rules as broad', async () => {
    const f = verifyArtefacts(await built({ ubo: [...UBO, ...corpus.map((r) => b(r))] })).failures.join('\n');
    expect(f).toMatch(/ubo: 7 rule\(s\) allow every host or a whole suffix/);
  });
});

const RULESETS = path.join(ROOT, 'public/rulesets');
describe.skipIf(!existsSync(RULESETS))('the built safe rulesets pass the checker (D-72)', () => {
  test('0 catch-all rejections in every non -x ruleset', () => {
    const safe = readdirSync(RULESETS).filter((f) => f.endsWith('.json') && !f.endsWith('-x.json'));
    expect(safe.length).toBeGreaterThan(5);
    const rejected = safe.flatMap((f) => {
      const bytes = new Uint8Array(readFileSync(path.join(RULESETS, f)));
      return rulesetProblems(`rulesets/${f}`, bytes, bytes).filter((p) => p.includes('catch-all'));
    });
    expect(rejected).toEqual([]);
  });
});
