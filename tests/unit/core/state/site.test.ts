import { describe, expect, test } from 'vitest';
import type { Hostname } from '../../../../src/core/ids.js';
import { MAX_SITES_PER_LEVEL } from '../../../../src/core/limits.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import { siteSnapshotOf, withPause } from '../../../../src/core/state/site.js';
import type { Settings } from '../../../../src/core/state/types.js';

const NOW = 1_800_000_000_000;
const HOST = 'news.example.com' as Hostname;
const base = (over: Partial<Settings> = {}): Settings => ({ ...createDefaultSettings(), ...over });

describe('withPause (c/pauseSite, P2-10)', () => {
  test('30 and 60 minutes store a pause that ends then; the host keeps its own level', () => {
    const settings = base({ siteLevels: { [HOST]: 'thorough' } });
    expect(withPause(settings, HOST, 30, NOW)).toMatchObject({ pauses: { [HOST]: { until: NOW + 30 * 60_000 } }, siteLevels: { [HOST]: 'thorough' } });
    expect(withPause(settings, HOST, 60, NOW)?.pauses[HOST]).toEqual({ until: NOW + 60 * 60_000 });
  });

  test('"until I turn it back on" stores Off on the host and drops its pause', () => {
    const settings = base({ pauses: { [HOST]: { until: NOW + 5 } } });
    expect(withPause(settings, HOST, null, NOW)).toMatchObject({ siteLevels: { [HOST]: 'off' }, pauses: {} });
  });

  test('expired pauses are dropped, so they never count against the cap', () => {
    const old = { ['old.example' as Hostname]: { until: NOW - 1 } };
    expect(withPause(base({ pauses: old }), HOST, 30, NOW)?.pauses).toEqual({ [HOST]: { until: NOW + 30 * 60_000 } });
  });

  test('a new host over the cap is refused with null; an existing one may be re-paused', () => {
    const full = Object.fromEntries(Array.from({ length: MAX_SITES_PER_LEVEL }, (_, i) => [`s${String(i)}.example`, { until: NOW + 1_000 }]));
    const settings = base({ pauses: full });
    expect(withPause(settings, HOST, 30, NOW)).toBeNull();
    expect(withPause(settings, 's1.example' as Hostname, 60, NOW)?.pauses['s1.example' as Hostname]).toEqual({ until: NOW + 60 * 60_000 });
  });

  test('never mutates its input', () => {
    const settings = Object.freeze(base());
    expect(() => withPause(settings, HOST, 30, NOW)).not.toThrow();
    expect(settings.pauses).toEqual({});
  });
});

describe('siteSnapshotOf: the host own stored values (breakage compare-and-revert)', () => {
  test('nothing stored', () => {
    expect(siteSnapshotOf(base(), HOST, NOW)).toEqual({ ownLevel: null, popupPolicy: null, pausedUntil: null });
  });

  test('own level, pop-up policy and an active pause; a parent setting is not the host own', () => {
    const settings = base({
      siteLevels: { [HOST]: 'light', ['example.com' as Hostname]: 'thorough' },
      pauses: { [HOST]: { until: NOW + 10 } },
      popups: { mode: 'smart', notice: true, sites: { [HOST]: 'allow' } },
    });
    expect(siteSnapshotOf(settings, HOST, NOW)).toEqual({ ownLevel: 'light', popupPolicy: 'allow', pausedUntil: NOW + 10 });
    expect(siteSnapshotOf(settings, 'example.com' as Hostname, NOW)).toEqual({ ownLevel: 'thorough', popupPolicy: null, pausedUntil: null });
  });

  test('an expired pause is not reported', () => {
    expect(siteSnapshotOf(base({ pauses: { [HOST]: { until: NOW } } }), HOST, NOW).pausedUntil).toBeNull();
  });
});
