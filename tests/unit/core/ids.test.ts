import { describe, expect, test } from 'vitest';
import { parsePackId, parseRulesetId, isUnsafeRulesetId } from '../../../src/core/ids.js';

describe('parseRulesetId', () => {
  test.each(['ubo', 'ubo-x', 'reg-de', 'reg-es-pt-x', 'annoy-overlays', 'popups', 'gpc-x'])(
    'accepts %s',
    (id) => {
      expect(parseRulesetId(id)).toBe(id);
    },
  );

  test.each(['', 'UBO', '_ubo', 'ubo-', '-ubo', 'ubo--x', 'ubo x', 'ubo/x', 'a'.repeat(65), 'ü'])(
    'rejects %j',
    (id) => {
      expect(parseRulesetId(id)).toBeNull();
    },
  );

  test('rejects non-strings', () => {
    expect(parseRulesetId(42)).toBeNull();
    expect(parseRulesetId(undefined)).toBeNull();
  });
});

describe('isUnsafeRulesetId', () => {
  test('treats every id ending in -x as unsafe', () => {
    const unsafe = parseRulesetId('ubo-x');
    const safe = parseRulesetId('ubo');
    expect(unsafe && isUnsafeRulesetId(unsafe)).toBe(true);
    expect(safe && isUnsafeRulesetId(safe)).toBe(false);
  });
});

describe('parsePackId', () => {
  test.each(['ads', 'trackers', 'annoy-social', 'reg-es-pt'])('accepts %s', (id) => {
    expect(parsePackId(id)).toBe(id);
  });

  test.each(['', 'Ads', 'ads!', 'a'.repeat(65), null])('rejects %j', (id) => {
    expect(parsePackId(id)).toBeNull();
  });
});

describe('ids must start with a letter (review LOW: integer-like keys reorder)', () => {
  test.each(['123', '1a', '0'])('rejects %s', (id) => {
    expect(parseRulesetId(id)).toBeNull();
    expect(parsePackId(id)).toBeNull();
  });
});
