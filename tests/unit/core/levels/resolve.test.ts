import { describe, expect, test } from 'vitest';
import { parseHostname } from '../../../../src/core/hostname/validate.js';
import type { Hostname } from '../../../../src/core/ids.js';
import { minLevel, nextPauseExpiry, resolveLevel } from '../../../../src/core/levels/resolve.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import type { DefaultLevel, Level, Settings } from '../../../../src/core/state/types.js';

const NOW = 1_800_000_000_000;
const h = (s: string): Hostname => parseHostname(s) ?? expect.fail(`bad host ${s}`);

function settingsWith(
  siteLevels: Record<string, Level>,
  pauses: Record<string, number> = {},
  defaultLevel: DefaultLevel = 'standard',
): Settings {
  return {
    ...createDefaultSettings(),
    defaultLevel,
    siteLevels: siteLevels,
    pauses: Object.fromEntries(Object.entries(pauses).map(([k, until]) => [k, { until }])),
  };
}

describe('resolveLevel: inheritance', () => {
  test.each<[string, Record<string, Level>, string, Level, string | null]>([
    ['no setting → default', {}, 'a.com', 'standard', null],
    ['own setting', { 'a.com': 'thorough' }, 'a.com', 'thorough', 'a.com'],
    ['inherited from a parent', { 'a.com': 'light' }, 'x.y.a.com', 'light', 'a.com'],
    ['no partial-label match', { 'a.com': 'off' }, 'ba.com', 'standard', null],
    ['child lower than parent', { 'a.com': 'standard', 'b.a.com': 'light' }, 'b.a.com', 'light', 'b.a.com'],
    ['child off under light parent', { 'a.com': 'light', 'b.a.com': 'off' }, 'c.b.a.com', 'off', 'b.a.com'],
    ['parent off is not overridable by a child', { 'a.com': 'off', 'b.a.com': 'thorough' }, 'b.a.com', 'off', 'a.com'],
    ['parent light caps a standard child', { 'a.com': 'light', 'b.a.com': 'standard' }, 'b.a.com', 'light', 'a.com'],
    ['thorough parent, standard child', { 'a.com': 'thorough', 'b.a.com': 'standard' }, 'b.a.com', 'standard', 'b.a.com'],
    ['standard parent caps a thorough child', { 'a.com': 'standard', 'b.a.com': 'thorough' }, 'b.a.com', 'standard', 'a.com'],
    ['the lowest ancestor wins', { 'a.com': 'light', 'b.a.com': 'off', 'c.b.a.com': 'thorough' }, 'c.b.a.com', 'off', 'b.a.com'],
  ])('%s', (_name, siteLevels, host, level, setOn) => {
    const resolved = resolveLevel(settingsWith(siteLevels), h(host), NOW);

    expect(resolved.level).toBe(level);
    expect(resolved.setOn).toBe(setOn);
    expect(resolved.pausedUntil).toBeNull();
  });

  test('a child may go above a non-default global level', () => {
    const settings = settingsWith({ 'a.com': 'thorough' }, {}, 'light');

    expect(resolveLevel(settings, h('a.com'), NOW).level).toBe('thorough');
    expect(resolveLevel(settings, h('b.com'), NOW).level).toBe('light');
  });
});

describe('resolveLevel: pauses', () => {
  test('an active pause turns the site off until it expires', () => {
    const settings = settingsWith({ 'a.com': 'thorough' }, { 'a.com': NOW + 60_000 });

    expect(resolveLevel(settings, h('a.com'), NOW)).toEqual({
      level: 'off',
      setOn: 'a.com',
      pausedUntil: NOW + 60_000,
    });
  });

  test('a pause on a parent covers its subdomains', () => {
    const settings = settingsWith({}, { 'a.com': NOW + 1 });
    expect(resolveLevel(settings, h('www.a.com'), NOW).level).toBe('off');
  });

  test('an expired pause is ignored', () => {
    const settings = settingsWith({ 'a.com': 'light' }, { 'a.com': NOW });

    expect(resolveLevel(settings, h('a.com'), NOW)).toEqual({ level: 'light', setOn: 'a.com', pausedUntil: null });
  });

  test('an explicit off is reported in preference to a pause', () => {
    const settings = settingsWith({ 'a.com': 'off' }, { 'b.a.com': NOW + 1 });
    expect(resolveLevel(settings, h('b.a.com'), NOW)).toMatchObject({ level: 'off', setOn: 'a.com', pausedUntil: null });
  });
});

describe('nextPauseExpiry', () => {
  test('returns the earliest future expiry, or null', () => {
    expect(nextPauseExpiry(settingsWith({}, { 'a.com': NOW + 5, 'b.com': NOW + 2, 'c.com': NOW - 1 }), NOW)).toBe(NOW + 2);
    expect(nextPauseExpiry(settingsWith({}, { 'c.com': NOW }), NOW)).toBeNull();
  });
});

describe('minLevel', () => {
  test('orders off < light < standard < thorough', () => {
    expect(minLevel('thorough', 'standard')).toBe('standard');
    expect(minLevel('light', 'thorough')).toBe('light');
    expect(minLevel('off', 'light')).toBe('off');
  });
});

describe('resolveLevel: prototype keys (review HIGH)', () => {
  // `constructor` itself is no longer a hostname (P2-43 review A-2); `valueof` keeps a bare prototype key here.
  test.each(['valueof', 'foo.constructor', 'tostring', 'hasownproperty'])('%s resolves to the default', (host) => {
    expect(resolveLevel(settingsWith({}), h(host), NOW)).toEqual({ level: 'standard', setOn: null, pausedUntil: null });
  });
});
