import { describe, expect, test } from 'vitest';
import { resolveLevel } from '../../../../src/core/levels/resolve.js';
import { withSiteLevel } from '../../../../src/core/levels/siteLevel.js';
import type { Hostname } from '../../../../src/core/ids.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import type { Settings } from '../../../../src/core/state/types.js';

const NOW = 1_800_000_000_000;
const HOST = 'news.example.com' as Hostname;
const PARENT = 'example.com' as Hostname;
const base = (over: Partial<Settings> = {}): Settings => ({ ...createDefaultSettings(), ...over });

describe('withSiteLevel (c/setSiteLevel)', () => {
  test('stores an explicit level and returns a new object', () => {
    const before = base();
    const after = withSiteLevel(before, HOST, 'thorough', NOW);
    expect(after.siteLevels).toEqual({ [HOST]: 'thorough' });
    expect(before.siteLevels).toEqual({});
    expect(after).not.toBe(before);
  });

  test('a child set above a lower parent stays stored, but the parent caps the effective level', () => {
    const after = withSiteLevel(base({ siteLevels: { [PARENT]: 'light' } }), HOST, 'thorough', NOW);
    expect(after.siteLevels).toEqual({ [PARENT]: 'light', [HOST]: 'thorough' });
    expect(resolveLevel(after, HOST, NOW)).toMatchObject({ level: 'light', setOn: PARENT });
  });

  test('inherit ("Turn on") removes the host’s own level, leaving others', () => {
    const after = withSiteLevel(base({ siteLevels: { [HOST]: 'off', [PARENT]: 'thorough' } }), HOST, 'inherit', NOW);
    expect(after.siteLevels).toEqual({ [PARENT]: 'thorough' });
  });

  test('inherit ("Resume now") also clears the host’s pause', () => {
    const after = withSiteLevel(base({ pauses: { [HOST]: { until: NOW + 1 }, [PARENT]: { until: NOW + 1 } } }), HOST, 'inherit', NOW);
    expect(after.pauses).toEqual({ [PARENT]: { until: NOW + 1 } });
    expect(resolveLevel(after, 'a.news.example.com' as Hostname, NOW).setOn).toBe(PARENT);
  });

  test('resuming a paused host keeps the level the user had chosen there (unless it was Off)', () => {
    const paused = { [HOST]: { until: NOW + 60_000 } };
    expect(withSiteLevel(base({ siteLevels: { [HOST]: 'light' }, pauses: paused }), HOST, 'inherit', NOW).siteLevels).toEqual({ [HOST]: 'light' });
    expect(withSiteLevel(base({ siteLevels: { [HOST]: 'off' }, pauses: paused }), HOST, 'inherit', NOW).siteLevels).toEqual({});
  });

  test('an expired pause does not protect the level: inherit removes both', () => {
    const after = withSiteLevel(base({ siteLevels: { [HOST]: 'light' }, pauses: { [HOST]: { until: NOW - 1 } } }), HOST, 'inherit', NOW);
    expect(after).toMatchObject({ siteLevels: {}, pauses: {} });
  });

  test('prototype-named hosts are plain keys', () => {
    const after = withSiteLevel(base(), '__proto__' as Hostname, 'light', NOW);
    expect(Object.hasOwn(after.siteLevels, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(after.siteLevels)).toBe(Object.prototype);
    expect(withSiteLevel(after, '__proto__' as Hostname, 'inherit', NOW).siteLevels).toEqual({});
  });
});
