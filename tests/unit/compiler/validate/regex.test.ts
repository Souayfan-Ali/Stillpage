import { describe, expect, test } from 'vitest';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import type { BucketedRule } from '../../../../compiler/postpass/coalesce.js';
import { emptyRegexCache, queryKey, queryOf, resolveRegexes, RegexCacheSchema, type RegexChecker, type RegexQuery } from '../../../../compiler/validate/regex.js';
import { validateRules } from '../../../../compiler/validate/validate.js';

const src = (line: number) => ({ text: 't', source: { list: 'l', line, text: `f${String(line)}` }, fixes: [] });
const b = (id: number, condition: DnrRule['condition'], action: DnrRule['action'] = { type: 'block' }): BucketedRule =>
  ({ rule: { id, priority: 10, action, condition }, sources: [src(id)], bucket: 'other:ads' });

/** Fake Chromium: refuses regexes containing a back-reference, records what it was asked. */
function fakeChecker(): RegexChecker & { asked: RegexQuery[][] } {
  const asked: RegexQuery[][] = [];
  return {
    id: 'chromium-test',
    asked,
    check: (qs) => {
      asked.push([...qs]);
      return Promise.resolve(qs.map((q) => (/\\\d/.test(q.regex) ? { isSupported: false, reason: 'syntaxError' } : { isSupported: true })));
    },
  };
}

describe('regex gate (P1-23): Chromium decides, never re2-wasm', () => {
  test('a query carries the flags isRegexSupported needs', () => {
    expect(queryOf(b(1, { regexFilter: 'a+', isUrlFilterCaseSensitive: true }).rule)).toEqual({ regex: 'a+', isCaseSensitive: true, requireCapturing: false });
    expect(queryOf(b(1, { regexFilter: '(a)' }, { type: 'redirect', redirect: { regexSubstitution: '\\1' } }).rule))
      .toEqual({ regex: '(a)', isCaseSensitive: false, requireCapturing: true });
    expect(queryOf(b(1, { urlFilter: '||a^' }).rule)).toBeUndefined();
    expect(queryKey({ regex: 'a', isCaseSensitive: false, requireCapturing: false })).toMatch(/^[0-9a-f]{64}$/);
    expect(queryKey({ regex: 'a', isCaseSensitive: true, requireCapturing: false }))
      .not.toBe(queryKey({ regex: 'a', isCaseSensitive: false, requireCapturing: false }));
  });

  test('asks Chromium once per distinct regex, then answers from the cache', async () => {
    const checker = fakeChecker();
    const qs: RegexQuery[] = ['a+', 'b(c)\\1', 'a+'].map((regex) => ({ regex, isCaseSensitive: false, requireCapturing: false }));
    const first = await resolveRegexes(qs, emptyRegexCache(checker.id), checker);
    expect(checker.asked).toEqual([[qs[0], qs[1]]]);
    expect(first.asked).toBe(2);
    const second = await resolveRegexes(qs, first.cache, checker);
    expect(checker.asked).toHaveLength(1);
    expect(second.asked).toBe(0);
    expect([...second.answers.values()].map((a) => a.isSupported).sort()).toEqual([false, true]);
    expect(RegexCacheSchema.parse(JSON.parse(JSON.stringify(second.cache)))).toEqual(second.cache);
  });

  test('a cache written by another Chromium build is ignored', async () => {
    const checker = fakeChecker();
    const q: RegexQuery = { regex: 'a', isCaseSensitive: false, requireCapturing: false };
    const stale = { ...emptyRegexCache('chromium-old'), results: { [queryKey(q)]: { isSupported: false } } };
    const r = await resolveRegexes([q], stale, checker);
    expect(r.asked).toBe(1);
    expect(r.cache.chromium).toBe('chromium-test');
    expect(r.answers.get(queryKey(q))?.isSupported).toBe(true);
  });

  test('a checker that answers the wrong number of queries fails the build', async () => {
    const bad: RegexChecker = { id: 'x', check: () => Promise.resolve([]) };
    await expect(resolveRegexes([{ regex: 'a', isCaseSensitive: false, requireCapturing: false }], emptyRegexCache('x'), bad))
      .rejects.toThrow(/answered 0 of 1/);
  });
});

describe('validateRules (P1-23)', () => {
  test('drops and logs unsupported regexes and bad shapes, one log entry per source filter', async () => {
    const rules = [b(1, { regexFilter: 'ok+' }), b(2, { regexFilter: '(x)\\1' }), b(3, { urlFilter: '||*.example^' }), b(4, { urlFilter: '||fine.example^' })];
    const checker = fakeChecker();
    const qs = rules.flatMap((r) => { const q = queryOf(r.rule); return q ? [q] : []; });
    const { answers } = await resolveRegexes(qs, emptyRegexCache(checker.id), checker);
    const r = validateRules(rules, answers);
    expect(r.kept.map((x) => x.rule.id)).toEqual([1, 4]);
    expect(r.log.map((l) => [l.source.line, l.reason, l.detail])).toEqual([[2, 'regex-unsupported', 'syntaxError'],
      [3, 'invalid-rule-shape', 'urlFilter starts with "||*"']]);
  });

  test('a regex without an answer fails the build (nothing leaves unchecked)', () => {
    expect(() => validateRules([b(1, { regexFilter: 'a' })], new Map())).toThrow(/no Chromium answer/);
  });
});
