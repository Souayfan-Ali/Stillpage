import { afterAll, describe, expect, test } from 'vitest';
import { chromiumRegexChecker, loadRulesets } from '../../compiler/chromium/node-ports.js';
import { emptyRegexCache, resolveRegexes, type RegexQuery } from '../../compiler/validate/regex.js';
import { expectNoSurvivors } from './helpers.js';

const q = (regex: string, extra: Partial<RegexQuery> = {}): RegexQuery => ({ regex, isCaseSensitive: false, requireCapturing: false, ...extra });

describe('Chromium-backed validation (P1-23)', () => {
  afterAll(() => { expectNoSurvivors(); });

  test('isRegexSupported answers like Chrome: syntax, memory limit, capturing groups', async () => {
    const checker = chromiumRegexChecker();
    const queries = [q('^https://ads\\.example/[0-9]+'), q('(?=lookahead)'), q('.{1000}'),
      q('^https://a\\.example/(.*)', { requireCapturing: true }), q('(a{1,1000}){1,1000}')];
    const { answers, asked } = await resolveRegexes(queries, emptyRegexCache(checker.id), checker);
    expect(asked).toBe(5);
    expect([...answers.values()]).toEqual([{ isSupported: true }, { isSupported: false, reason: 'syntaxError' },
      { isSupported: false, reason: 'memoryLimitExceeded' }, { isSupported: true }, { isSupported: false, reason: 'syntaxError' }]);
  });

  test('valid rulesets load and are all enabled; one invalid rule stops the extension from starting (S-18)', async () => {
    const good = { id: 'a', rules: [{ id: 1, priority: 10, action: { type: 'block' as const }, condition: { urlFilter: '||ads.example^' } }] };
    const loaded = await loadRulesets([good, { id: 'a-x', rules: [] }]);
    expect(loaded.enabled).toEqual(['a', 'a-x']);
    expect(loaded.available).toBe(330_000 - 1);
    const bad = { id: 'b', rules: [{ id: 1, priority: 10, action: { type: 'block' as const }, condition: { urlFilter: '||*.example^' } }] };
    await expect(loadRulesets([good, bad])).rejects.toThrow(/did not start/);
  });
});
