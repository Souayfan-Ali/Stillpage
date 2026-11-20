/**
 * D-34 / P2-30: `$removeparam` compiled by the converter as a regex (host + "the query has this key") is
 * rewritten to uBOL's form, `urlFilter` + `queryTransform`. Chrome does not redirect when the transform
 * leaves the URL unchanged, so the key check is not needed, and each rewrite frees one regex.
 */
import { describe, expect, test } from 'vitest';
import type { ConvertedRule } from '../../../../compiler/convert/convert.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { mergeRemoveParams, removeparamAsUrlFilter } from '../../../../compiler/postpass/removeparam.js';

const PREFIX = '^[a-z][a-z0-9+.-]*://(?:[^[:^ascii:]/?#@]*@)?(?:[^[:^ascii:]/?#@]*\\.)?';
const HOST_END = '(?:[^[:^ascii:] a-zA-Z0-9.%_/?#@-][^[:^ascii:]/?#@]*)?(?:/[^[:^ascii:]?#]*)?';
const PATH_END = '(?:[^[:^ascii:] a-zA-Z0-9.%_?#-][^[:^ascii:]?#]*)?';
const QUERY = '\\?(?:[^[:^ascii:]#]*&)?';

function rule(regexFilter: string, params: readonly string[] = ['utm_content'], extra: Partial<DnrRule['condition']> = {}): ConvertedRule {
  return {
    rule: {
      id: 1,
      priority: 10,
      action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: params } } } },
      condition: { regexFilter, resourceTypes: ['main_frame'], ...extra },
    },
    sources: [],
  };
}

describe('removeparam rules as urlFilter + queryTransform', () => {
  test('host form → ||host^, other condition keys kept', () => {
    const [out] = removeparamAsUrlFilter([rule(`${PREFIX}reddit\\.com${HOST_END}${QUERY}utm_content=`, ['utm_content'], { initiatorDomains: ['a.test'] })]);
    expect(out?.rule.condition).toEqual({ urlFilter: '||reddit.com^', resourceTypes: ['main_frame'], initiatorDomains: ['a.test'] });
    expect(out?.rule.action).toEqual({ type: 'redirect', redirect: { transform: { queryTransform: { removeParams: ['utm_content'] } } } });
  });

  test('host + path form → ||host/path^', () => {
    const [out] = removeparamAsUrlFilter([rule(`${PREFIX}x\\.example\\.org\\/public\\/widget\\/data${PATH_END}${QUERY}ei=`, ['ei'])]);
    expect(out?.rule.condition.urlFilter).toBe('||x.example.org/public/widget/data^');
    expect(out?.rule.condition.regexFilter).toBeUndefined();
  });

  test('anything else is left as it is: other shapes, other params, several params, non-transform rules', () => {
    const odd = [
      rule(`${PREFIX}reddit\\.com${HOST_END}${QUERY}utm_[a-z]+=`, ['utm_x']),
      rule(`${PREFIX}reddit\\.com${HOST_END}${QUERY}ei=`, ['other']),
      rule(`${PREFIX}reddit\\.com${HOST_END}${QUERY}ei=`, ['ei', 'fb']),
      rule(`^https://reddit\\.com/\\?ei=`, ['ei']),
      { rule: { id: 2, priority: 1, action: { type: 'block' }, condition: { regexFilter: `${PREFIX}a\\.com${HOST_END}${QUERY}ei=` } } as DnrRule, sources: [] },
    ];
    expect(removeparamAsUrlFilter(odd)).toEqual(odd);
  });
});

describe('removeparam rules with the same condition share one rule', () => {
  const rp = (id: number, params: readonly string[], condition: DnrRule['condition'], priority = 10): ConvertedRule => ({
    rule: { id, priority, action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: params } } } }, condition },
    sources: [{ list: 'l', line: id, text: `#${String(id)}` }] as unknown as ConvertedRule['sources'],
  });

  test('params of one condition and priority are merged (sorted, unique); sources are kept', () => {
    const merged = mergeRemoveParams([
      rp(1, ['b'], { urlFilter: '||a.com^' }),
      rp(2, ['a', 'b'], { urlFilter: '||a.com^' }),
      rp(3, ['c'], { urlFilter: '||b.com^' }),
      rp(4, ['d'], { urlFilter: '||a.com^' }, 11),
    ]);
    expect(merged.map((r) => [r.rule.condition.urlFilter, r.rule.priority, r.rule.action.redirect?.transform?.queryTransform?.removeParams])).toEqual([
      ['||a.com^', 10, ['a', 'b']],
      ['||b.com^', 10, ['c']],
      ['||a.com^', 11, ['d']],
    ]);
    expect(merged[0]?.sources).toHaveLength(2);
  });

  test('other rules pass through in place', () => {
    const block = { rule: { id: 9, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||a.com^' } } as DnrRule, sources: [] };
    expect(mergeRemoveParams([block])).toEqual([block]);
  });
});
