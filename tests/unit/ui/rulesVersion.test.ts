import { describe, expect, test } from 'vitest';
import { formatRulesDate } from '../../../src/ui/rulesVersion.js';

describe('UI rules date (UI notes: "Rules from 13 Nov 2026")', () => {
  test('formats day month year in UTC, whatever the reader time zone', () => {
    expect(formatRulesDate('1.0.317.600')).toBe('13 Nov 2026');
    expect(formatRulesDate('1.0.317.15')).toBe('13 Nov 2026');
    expect(formatRulesDate('1.0.317.2359')).toBe('13 Nov 2026');
  });

  test('a version without a rules date shows none', () => {
    expect(formatRulesDate('0.0.1')).toBeUndefined();
  });

  test('keeps the day-month-year order in another locale', () => {
    expect(formatRulesDate('1.0.317.600', 'en-US')).toBe('13 Nov 2026');
    expect(formatRulesDate('1.0.317.600', 'de')).toMatch(/^13 Nov\.? 2026$/);
  });
});
