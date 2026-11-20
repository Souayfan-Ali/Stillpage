import { describe, expect, test } from 'vitest';
import { daysIn, decide, STREAK_FOR_ISSUE } from '../../../scripts/oracle/streak.js';

const body = (days: readonly string[]): string => `Oracle failed.\n<!-- oracle-days: ${JSON.stringify(days)} -->\n`;

describe('oracle warn-day streak (D-40)', () => {
  test('first warn day: recorded, no issue', () => {
    expect(decide(null, '2026-11-11', true)).toEqual({ days: ['2026-11-11'], streak: 1, openIssue: false, marker: '<!-- oracle-days: ["2026-11-11"] -->' });
  });

  test(`${String(STREAK_FOR_ISSUE)} consecutive warn days open the tracking issue; a gap restarts the count`, () => {
    expect(decide(body(['2026-11-11', '2026-11-12']), '2026-11-13', true)).toMatchObject({ streak: 3, openIssue: true });
    expect(decide(body(['2026-11-10', '2026-11-12']), '2026-11-13', true)).toMatchObject({ streak: 2, openIssue: false });
    expect(decide(body(['2026-11-11', '2026-11-12', '2026-11-13']), '2026-11-14', true)).toMatchObject({ streak: 4, openIssue: true });
  });

  test('a day without an oracle failure ends the streak; a rerun on the same day counts once', () => {
    expect(decide(body(['2026-11-11', '2026-11-12']), '2026-11-13', false)).toEqual({ days: [], streak: 0, openIssue: false, marker: '<!-- oracle-days: [] -->' });
    expect(decide(body(['2026-11-12', '2026-11-13']), '2026-11-13', true)).toMatchObject({ days: ['2026-11-12', '2026-11-13'], streak: 2 });
  });

  test('the PR body is untrusted: garbage and bad dates are ignored; a bad --today throws', () => {
    expect(daysIn('<!-- oracle-days: [not json] -->')).toEqual([]);
    expect(daysIn(body(['2026-11-11', 'x', '2026-11-11', '../../etc']))).toEqual(['2026-11-11']);
    expect(daysIn('no marker')).toEqual([]);
    expect(() => decide(null, '13/11/2026', true)).toThrow(/YYYY-MM-DD/);
    expect(() => decide(null, '2026-02-31', true)).toThrow(/YYYY-MM-DD/);
    expect(() => decide(null, '2026-13-45', true)).toThrow(/YYYY-MM-DD/);
    expect(daysIn(body(['2026-02-31', '2026-11-11']))).toEqual(['2026-11-11']);
  });
});
