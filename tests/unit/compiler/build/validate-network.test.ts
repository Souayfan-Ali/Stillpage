import { describe, expect, test } from 'vitest';
import type { NetworkRuleset } from '../../../../compiler/build/network.js';
import { regexQueries, validateNetwork } from '../../../../compiler/build/validate-network.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import type { BucketedRule } from '../../../../compiler/postpass/coalesce.js';
import { queryKey } from '../../../../compiler/validate/regex.js';

const src = { text: 't', source: { list: 'l', line: 1, text: 't' }, fixes: [] };
const b = (rule: Omit<DnrRule, 'id'>): BucketedRule => ({ rule: { id: 1, ...rule }, sources: [src], bucket: 'other:ads' });
const ruleset = (safe: BucketedRule[], unsafe: BucketedRule[]): NetworkRuleset => ({
  config: { id: 'ubo', pack: 'ads', category: 'ads', lists: ['l'], slots: { safe: { rules: 10, regex: 1 } } }, safe, unsafe, maximal: 0, popupEntries: [], rest: [], log: [], redirectNone: 0, networkFilters: 0,
});
const ok = (regex: string): [string, { isSupported: boolean }] => [queryKey({ regex, isCaseSensitive: false, requireCapturing: false }), { isSupported: true }];

describe('validateNetwork (P1-23)', () => {
  const regexBlock = b({ priority: 110, action: { type: 'block' }, condition: { regexFilter: '^bad(' } });
  const redirect = b({ priority: 1110, action: { type: 'redirect', redirect: { extensionPath: '/surrogates/noop.js' } }, condition: { regexFilter: '^ok' } });

  test('collects queries from both halves', () => {
    expect(regexQueries([ruleset([regexBlock], [redirect])])).toHaveLength(2);
  });

  test('drops refused rules into the log', () => {
    const out = validateNetwork([ruleset([regexBlock], [])], new Map([[queryKey({ regex: '^bad(', isCaseSensitive: false, requireCapturing: false }),
      { isSupported: false, reason: 'syntaxError' }]]));
    expect(out[0]?.safe).toEqual([]);
    expect(out[0]?.log.map((l) => l.reason)).toEqual(['regex-unsupported']);
  });

  test('a redirect whose block was dropped is dropped too and logged', () => {
    const badBlock = b({ priority: 110, action: { type: 'block' }, condition: { regexFilter: '^ok', resourceTypes: [] } });
    const out = validateNetwork([ruleset([badBlock], [redirect])], new Map([ok('^ok')]));
    expect(out[0]?.unsafe).toEqual([]);
    expect(out[0]?.log.map((l) => l.reason)).toEqual(['invalid-rule-shape', 'redirect-uncovered']);
    const goodBlock = b({ priority: 110, action: { type: 'block' }, condition: { regexFilter: '^ok' } });
    expect(validateNetwork([ruleset([goodBlock], [redirect])], new Map([ok('^ok')]))[0]?.unsafe).toHaveLength(1);
  });
});
