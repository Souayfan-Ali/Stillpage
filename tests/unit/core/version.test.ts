import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { compareVersions, decodeVersion, encodeVersion, rulesDateOf } from '../../../src/core/version.js';

const at = (iso: string): Date => new Date(iso);
const line = { major: 1, minor: 0 };
const NOW = at('2026-11-14T12:00:00Z');

describe('version scheme MAJOR.MINOR.RULES_DAY.RULES_HHMM (update-strategy notes §7, P2-03)', () => {
  test('encodes the examples of update-strategy notes §7', () => {
    expect(encodeVersion(line, at('2026-11-13T06:00:00Z'), NOW)).toBe('1.0.317.600');
    expect(encodeVersion(line, at('2026-11-14T06:00:00Z'), NOW)).toBe('1.0.318.600');
    expect(encodeVersion({ major: 1, minor: 1 }, at('2026-01-01T00:00:59Z'), NOW)).toBe('1.1.1.0');
    expect(encodeVersion(line, at('2026-11-13T23:59:00Z'), NOW)).toBe('1.0.317.2359');
  });

  test('decodes day and HHMM back to the snapshot minute', () => {
    expect(decodeVersion('1.0.317.600')).toEqual({ major: 1, minor: 0, day: 317, hhmm: 600 });
    expect(rulesDateOf('1.0.317.605')?.toISOString()).toBe('2026-11-13T06:05:00.000Z');
  });

  test('refuses a snapshot before day 1, too far ahead, in the future, or a bad code line', () => {
    expect(() => encodeVersion(line, at('2025-12-31T23:59:00Z'), NOW)).toThrow(/before/);
    expect(() => encodeVersion(line, at('2290-01-01T00:00:00Z'), at('2300-01-01T00:00:00Z'))).toThrow(/65535/);
    expect(() => encodeVersion(line, at('2026-11-14T12:10:00Z'), NOW)).toThrow(/future/);
    expect(encodeVersion(line, at('2026-11-14T12:04:00Z'), NOW)).toBe('1.0.318.1204');
    expect(() => encodeVersion({ major: 70000, minor: 0 }, at('2026-11-13T06:00:00Z'), NOW)).toThrow(/MAJOR/);
    expect(() => encodeVersion({ major: 1, minor: -1 }, at('2026-11-13T06:00:00Z'), NOW)).toThrow(/MINOR/);
    expect(() => encodeVersion(line, new Date(Number.NaN), NOW)).toThrow(/invalid/);
  });

  test.each(['0.0.1', '1.0.0.600', '1.0.317.2400', '1.0.317.660', '1.0.0317.600', '1.0.317.600.1', '1.0.+3.600', 'x', ''])(
    '%s has no rules date', (v) => {
      expect(decodeVersion(v)).toBeUndefined();
      expect(rulesDateOf(v)).toBeUndefined();
    });

  test('compares like Chrome: numeric parts, missing parts are zero', () => {
    expect(compareVersions('1.0.318.600', '1.0.317.2359')).toBeGreaterThan(0);
    expect(compareVersions('0.0.317.600', '0.0.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0', '1.0.0.0')).toBe(0);
    expect(compareVersions('1.0.9.0', '1.0.10.0')).toBeLessThan(0);
    expect(() => compareVersions('1.x', '1.0')).toThrow(/not a version/);
    expect(() => compareVersions('1.2.3.4.5', '1.0')).toThrow(/not a version/);
  });

  test('later snapshots give strictly greater versions (monotonic)', () => {
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2200, 0, 1);
    const minute = fc.integer({ min: start / 60_000, max: end / 60_000 });
    fc.assert(fc.property(minute, minute, (a, b) => {
      const far = new Date(end + 1);
      const va = encodeVersion(line, new Date(a * 60_000), far);
      const vb = encodeVersion(line, new Date(b * 60_000), far);
      expect(Math.sign(compareVersions(va, vb))).toBe(Math.sign(a - b));
      expect(rulesDateOf(va)?.getTime()).toBe(a * 60_000);
    }));
  });
});
