import { describe, expect, test } from 'vitest';
import { DnrRuleSchema, isSafeAction } from '../../../../compiler/dnr/schema.js';

const rule = { id: 1, priority: 10, action: { type: 'block' }, condition: { urlFilter: '||x.example^', topDomains: ['a.example'] } };

describe('DNR rule schema', () => {
  test('accepts a static rule with topDomains (Chrome 145+)', () => {
    expect(DnrRuleSchema.safeParse(rule).success).toBe(true);
  });

  test('rejects unknown keys anywhere (static files would ignore them silently, S-07)', () => {
    expect(DnrRuleSchema.safeParse({ ...rule, extra: 1 }).success).toBe(false);
    expect(DnrRuleSchema.safeParse({ ...rule, condition: { ...rule.condition, urlfilter: 'x' } }).success).toBe(false);
    expect(DnrRuleSchema.safeParse({ ...rule, id: 0 }).success).toBe(false);
  });

  test.each([['block', true], ['allow', true], ['allowAllRequests', true], ['upgradeScheme', true], ['redirect', false], ['modifyHeaders', false]] as const)(
    '%s is safe: %s',
    (type, safe) => {
      expect(isSafeAction({ type })).toBe(safe);
    },
  );
});
