import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { convertRuleset } from '../../../../compiler/convert/convert.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { collectBadfilters } from '../../../../compiler/normalise/badfilter.js';
import { normaliseRuleset } from '../../../../compiler/normalise/normalise.js';
import { classify } from '../../../../compiler/parse/classify.js';
import { bucketRuleset } from '../../../../compiler/postpass/buckets.js';
import type { BucketedRule } from '../../../../compiler/postpass/coalesce.js';
import { dedupe } from '../../../../compiler/postpass/dedupe.js';
import { shiftStockPriorities } from '../../../../compiler/postpass/priorities.js';
import { assertPurity, assertRedirectsCovered, splitSafeUnsafe, uncoveredRedirects } from '../../../../compiler/postpass/split.js';

const src = { text: 't', source: { list: 'l', line: 1, text: 't' }, fixes: [] };
const b = (id: number, rule: Omit<DnrRule, 'id'>): BucketedRule => ({ rule: { id, ...rule }, sources: [src], bucket: 'other:ads' });
const redirect = (condition: DnrRule['condition'], priority = 1110): BucketedRule =>
  b(1, { priority, action: { type: 'redirect', redirect: { extensionPath: '/surrogates/noopjs.js' } }, condition });
const block = (condition: DnrRule['condition'], priority = 110): BucketedRule => b(2, { priority, action: { type: 'block' }, condition });

async function pipeline(lines: readonly string[]) {
  const entries = lines.map((text, i) => ({ ...classify(text), source: { list: 'l', line: i + 1, text }, trusted: true }));
  const { rules } = await convertRuleset(normaliseRuleset(entries, collectBadfilters(entries)).inputs);
  return splitSafeUnsafe(bucketRuleset(shiftStockPriorities(dedupe(rules).rules), () => undefined, 'ads').rules);
}

describe('safe / unsafe split (P1-22)', () => {
  test('redirect and modifyHeaders go to -x, everything else stays safe', () => {
    const rules = [block({ urlFilter: '||a.example^' }), redirect({ urlFilter: '||a.example^' }),
      b(3, { action: { type: 'allow' }, condition: {} }), b(4, { action: { type: 'upgradeScheme' }, condition: {} }),
      b(5, { action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['main_frame'] } }),
      b(6, { action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x', operation: 'remove' }] }, condition: {} })];
    const { safe, unsafe } = splitSafeUnsafe(rules);
    expect(safe.map((r) => r.rule.action.type)).toEqual(['block', 'allow', 'upgradeScheme', 'allowAllRequests']);
    expect(unsafe.map((r) => r.rule.action.type)).toEqual(['redirect', 'modifyHeaders']);
    expect(() => { assertPurity('ubo', safe, unsafe); }).not.toThrow();
  });

  test('purity check fails on an unsafe rule in a safe file and on a safe rule in a -x file', () => {
    expect(() => { assertPurity('ubo', [redirect({})], []); }).toThrow(/unsafe action redirect in safe ruleset ubo/);
    expect(() => { assertPurity('ubo', [], [block({})]); }).toThrow(/safe action block in ubo-x/);
  });

  test('a redirect is covered by a coalesced block of the same condition at a lower priority', () => {
    const r = redirect({ urlFilter: '||cdn.a.example^', resourceTypes: ['script'] });
    const covering = block({ requestDomains: ['a.example', 'b.example'], resourceTypes: ['script'] });
    expect(uncoveredRedirects([covering], [r])).toEqual([]);
  });

  test('uncovered: no block, other types, an equal priority, narrower initiators', () => {
    const r = redirect({ urlFilter: '||a.example/x.js', resourceTypes: ['script'], initiatorDomains: ['s.example'] });
    expect(uncoveredRedirects([], [r])).toEqual([r]);
    expect(uncoveredRedirects([block({ urlFilter: '||a.example/x.js', resourceTypes: ['image'] })], [r])).toEqual([r]);
    expect(uncoveredRedirects([block({ urlFilter: '||a.example/x.js', resourceTypes: ['script'] }, 1110)], [r])).toEqual([r]);
    const narrow = block({ urlFilter: '||a.example/x.js', resourceTypes: ['script'], initiatorDomains: ['t.example'] });
    expect(uncoveredRedirects([narrow], [r])).toEqual([r]);
    const wide = block({ urlFilter: '||a.example/x.js', resourceTypes: ['script'], initiatorDomains: ['example', 'z.example'] });
    expect(uncoveredRedirects([wide], [r])).toEqual([]);
  });

  test('a block with hosts and another path does not cover a redirect (review MEDIUM 4)', () => {
    const r = redirect({ requestDomains: ['a.example'], urlFilter: '/x.js' });
    expect(uncoveredRedirects([block({ requestDomains: ['a.example'], urlFilter: '/ads/' })], [r])).toEqual([r]);
    expect(uncoveredRedirects([block({ requestDomains: ['a.example', 'b.example'], urlFilter: '/x.js' })], [r])).toEqual([]);
  });

  test('transform redirects (removeparam, uritransform) need no block', () => {
    const rp = b(9, { action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: ['utm'] } } } }, condition: {} });
    expect(uncoveredRedirects([], [rp])).toEqual([]);
  });

  test('the build fails and names the filter of an uncovered redirect', () => {
    expect(() => { assertRedirectsCovered('ubo', [], [redirect({ urlFilter: '||a.example^' })]); })
      .toThrow(/ubo-x: 1 redirect rule\(s\) without a covering block .*\bt\b/);
  });

  test('end to end: every $redirect= filter leaves a covering block in the safe half', async () => {
    const { safe, unsafe } = await pipeline(['||a.example/ad.js$script,redirect=noopjs', '||b.example^$script,redirect=noopjs,domain=s.example',
      '||c.example^$script,redirect=noopjs', '||c.example^$script', '@@||a.example/ad.js$script,domain=ok.example', '||d.example^$removeparam=utm']);
    expect(unsafe.filter((r) => r.rule.action.redirect?.extensionPath !== undefined)).toHaveLength(3);
    expect(uncoveredRedirects(safe, unsafe)).toEqual([]);
  });

  test('property: any mix of redirect and block filters is covered after the whole post-pass', async () => {
    const host = fc.constantFrom('a.example', 'b.example', 'x.a.example', 'c.example');
    const filter = fc.tuple(host, fc.constantFrom('', ',domain=s.example', ',domain=s.example|t.example', ',important'), fc.boolean())
      .map(([h, ctx, isRedirect]) => `||${h}^$script${isRedirect ? ',redirect=noopjs' : ''}${ctx}`);
    await fc.assert(fc.asyncProperty(fc.array(filter, { minLength: 1, maxLength: 8 }), async (lines) => {
      const { safe, unsafe } = await pipeline(lines);
      expect(uncoveredRedirects(safe, unsafe)).toEqual([]);
    }), { numRuns: 25 });
  });
});
