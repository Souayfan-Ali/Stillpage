import { describe, expect, test } from 'vitest';
import * as L from '../../../src/core/limits.js';

describe('Chrome limits', () => {
  test('match the measured DNR limits', () => {
    expect(L.GUARANTEED_STATIC_RULES).toBe(30_000);
    expect(L.GLOBAL_STATIC_RULE_POOL).toBe(300_000);
    expect(L.MAX_DECLARED_RULESETS).toBe(100);
    expect(L.MAX_ENABLED_RULESETS).toBe(50);
    expect(L.MAX_DYNAMIC_RULES).toBe(30_000);
    expect(L.MAX_UNSAFE_DYNAMIC_RULES).toBe(5_000);
    expect(L.MAX_SESSION_RULES).toBe(5_000);
    expect(L.MAX_DISABLED_STATIC_RULES).toBe(5_000);
    expect(L.REGEX_MAX_COMPILED_BYTES).toBe(2_048);
    expect(L.MAX_RULE_PRIORITY).toBe(2_147_483_647);
    expect(L.MAX_UNSAFE_SESSION_RULES).toBe(5_000);
    expect(L.MIN_RULE_ID).toBe(1);
  });

  test('allow 20 getMatchedRules calls per 10 minutes outside a gesture', () => {
    expect(L.MAX_GET_MATCHED_RULES_CALLS).toBe(20);
    expect(L.GET_MATCHED_RULES_INTERVAL_MINUTES).toBe(10);
  });

  test('count regex in two pools: enabled static rulesets, and dynamic plus session together', () => {
    expect(L.STATIC_REGEX_POOL).toBe(1_000);
    expect(L.DYNAMIC_SESSION_REGEX_POOL).toBe(1_000);
  });
});

describe('budgets', () => {
  test('declare 36 ruleset slots, all of which can be enabled together', () => {
    expect(L.RULESET_SLOTS).toBe(36);
    expect(L.RULESET_SLOTS).toBeLessThanOrEqual(L.MAX_ENABLED_RULESETS);
  });

  test('cap a ruleset file at 10 MiB', () => {
    expect(L.MAX_RULESET_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  test('keep the default set inside the guaranteed rules and the static regex pool', () => {
    expect(L.DEFAULT_RULE_BUDGET).toBe(24_000);
    expect(L.DEFAULT_REGEX_BUDGET).toBe(420);
    expect(L.NON_REGIONAL_RULE_BUDGET).toBeLessThanOrEqual(L.GUARANTEED_STATIC_RULES);
    expect(L.NON_REGIONAL_REGEX_BUDGET).toBeLessThanOrEqual(L.STATIC_REGEX_POOL);
  });

  test('budget registration patterns at 40,000 default / 94,000 enabled together and 2,560 registrations (P2-32)', () => {
    expect(L.DEFAULT_PATTERN_BUDGET).toBe(40_000);
    expect(L.ENABLED_PATTERN_BUDGET).toBe(94_000);
    expect(L.REGISTRATION_BUDGET).toBe(2_560);
  });
});

describe('priority bands', () => {
  test('place pop-up rules at 1–3, below the shifted stock band', () => {
    expect(L.POPUP_PRIORITY).toEqual({ block: 1, redirect: 2, allow: 3 });
    expect(L.POPUP_PRIORITY.allow).toBeLessThan(1 + L.STOCK_PRIORITY_SHIFT);
  });

  test('lift band (D-55/D-55a): in the empty band above stock and below user rules, redirect < its Proceed once', () => {
    expect(L.POPUP_LIFT_PRIORITY).toEqual({ redirect: 5_000_000, allow: 5_000_001 });
    expect(L.POPUP_LIFT_PRIORITY.redirect).toBeGreaterThan(L.STOCK_PRIORITY_MAX);
    expect(L.POPUP_LIFT_PRIORITY.allow).toBeGreaterThan(L.POPUP_LIFT_PRIORITY.redirect);
    expect(L.POPUP_LIFT_PRIORITY.allow).toBeLessThan(L.USER_PRIORITY_BASE);
    expect(L.PROCEED_ONCE_URL_MAX_CHARS).toBe(2_048);
  });

  test('shift stock rules by 9 and cap them below 2,000,000', () => {
    expect(L.STOCK_PRIORITY_SHIFT).toBe(9);
    expect(L.STOCK_PRIORITY_MAX).toBe(1_999_999);
  });

  test('re-band (D-55b, after the 24-bit finding): user 10,000,000…12,999,999, switches 14,000,000, Off 15,000,000', () => {
    expect(L.USER_PRIORITY_BASE).toBe(10_000_000);
    expect(L.USER_RULE_PRIORITY_MAX).toBe(2_999_999);
    expect(L.SWITCH_PRIORITY).toBe(14_000_000);
    expect(L.OFF_PRIORITY).toBe(15_000_000);
    expect(L.CHROME_EFFECTIVE_PRIORITY_MAX).toBe(16_777_215);
    expect(L.MAX_RULE_PRIORITY).toBe(2_147_483_647);
  });

  test('every band in strict order and below the effective maximum (Chromium keeps 24 bits of priority)', () => {
    const order = [
      L.POPUP_PRIORITY.block, L.POPUP_PRIORITY.redirect, L.POPUP_PRIORITY.allow,
      1 + L.STOCK_PRIORITY_SHIFT, L.STOCK_PRIORITY_MAX,
      L.POPUP_LIFT_PRIORITY.redirect, L.POPUP_LIFT_PRIORITY.allow,
      L.USER_PRIORITY_BASE, L.USER_PRIORITY_BASE + L.USER_RULE_PRIORITY_MAX,
      L.SWITCH_PRIORITY, L.OFF_PRIORITY,
    ];
    expect(order.every((p, i) => i === 0 || p > (order[i - 1] ?? 0))).toBe(true);
    expect(L.OFF_PRIORITY).toBeLessThanOrEqual(L.CHROME_EFFECTIVE_PRIORITY_MAX);
  });
});

describe('id realms', () => {
  const realms = Object.values(L.DYNAMIC_ID_REALMS);

  test('never overlap', () => {
    const sorted = [...realms].sort((a, b) => a.min - b.min);
    sorted.slice(1).forEach((range, i) => {
      const previous = sorted[i];
      expect(previous && range.min > previous.max).toBe(true);
    });
  });

  test('stay inside the dynamic rule limit in size', () => {
    expect(L.DYNAMIC_ID_REALMS.siteState).toEqual({ min: 1_000_000, max: 1_000_099 });
    expect(L.DYNAMIC_ID_REALMS.popupDestinations).toEqual({ min: 1_200_000, max: 1_200_099 });
    expect(L.SESSION_ID_RANGE).toEqual({ min: 1, max: 4_999 });
    expect(L.SESSION_ID_RANGE.max).toBeLessThanOrEqual(L.MAX_SESSION_RULES);
  });

  test.each([
    [1, 'hotfix'],
    [99_999, 'hotfix'],
    [1_000_000, 'siteState'],
    [1_000_099, 'siteState'],
    [1_150_000, 'siteSwitches'],
    [1_200_050, 'popupDestinations'],
    [2_500_000, 'userRules'],
    [5_999_999, 'importedLists'],
  ] as const)('maps id %i to realm %s', (id, realm) => {
    expect(L.dynamicRealmOf(id)).toBe(realm);
  });

  test.each([0, 100_000, 1_000_100, 1_200_100, 6_000_000, 1.5, Number.NaN])(
    'maps id %d to no realm',
    (id) => {
      expect(L.dynamicRealmOf(id)).toBeNull();
    },
  );
});

describe('attribution bucket budgets (ADR-011)', () => {
  test('match the frozen caps', () => {
    expect(L.MAX_COMPANIES).toBe(300);
    expect(L.MAX_BUCKET_OVERHEAD).toBe(1_000);
    expect(L.MAX_BUCKETS_GZIP_BYTES).toBe(60_000);
  });
});

describe('input limits', () => {
  test('match DNS and the command limits', () => {
    expect(L.MAX_HOSTNAME_LENGTH).toBe(253);
    expect(L.MAX_LABEL_LENGTH).toBe(63);
    expect(L.MAX_SELECTOR_LENGTH).toBe(1_024);
    expect(L.MAX_BACKUP_BYTES).toBe(2 * 1024 * 1024);
    expect(L.MAX_SITES_PER_LEVEL).toBe(1_000);
    expect(L.SHARD_COUNT).toBe(256);
    expect(L.MAX_DECLARATION_LENGTH).toBe(1_024);
  });

  test('isInRange accepts integers inside a closed range only', () => {
    const range = { min: 1, max: 3 };
    expect([0, 1, 3, 4, 2.5].map((n) => L.isInRange(n, range))).toEqual([false, true, true, false, false]);
  });
});
