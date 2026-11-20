import { describe, expect, test } from 'vitest';
import type { Backup } from '../../../../src/core/state/backup.js';
import { deviceHostsOf, NO_DEVICE_HOSTS, withoutSuffixHosts, type DeviceHosts } from '../../../../src/core/state/backupHosts.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import type { Settings } from '../../../../src/core/state/types.js';

/**
 * P2-43 security review (A-1), design review: a backup is untrusted input; an entry for a whole suffix (`com`,
 * `co.uk`, any single label but `localhost`) would switch blocking Off, allow pop-ups or hide elements on
 * every site under it. A restore drops such entries and names them; everything else restores.
 */
const base = createDefaultSettings();
const backup = (hosts: readonly string[], filters: readonly string[] | null): Backup => ({
  settings: {
    defaultLevel: base.defaultLevel,
    siteLevels: Object.fromEntries(hosts.map((h) => [h, 'off'])),
    packs: base.packs,
    cookieBanners: base.cookieBanners,
    popups: { ...base.popups, sites: Object.fromEntries(hosts.map((h) => [h, 'allow'])) },
    gpc: base.gpc,
    ui: base.ui,
  },
  userFilters: filters === null ? null : { v: 1, hosts: Object.fromEntries(filters.map((h) => [h, ['body']])) },
});

describe('withoutSuffixHosts (P2-43, A-1)', () => {
  test('drops com, co.uk and single labels from every map, keeps localhost, sites and IP addresses, names each once', () => {
    const input = backup(['com', 'co.uk', 'nas', 'localhost', 'example.com', 'news.example.co.uk', '10.0.0.1'], ['org', 'localhost', 'a.example']);
    const before = JSON.stringify(input);
    const { backup: kept, hosts } = withoutSuffixHosts(input, NO_DEVICE_HOSTS);
    expect(hosts).toEqual(['co.uk', 'com', 'nas', 'org']);
    const keep = ['localhost', 'example.com', 'news.example.co.uk', '10.0.0.1'];
    expect(Object.keys(kept.settings.siteLevels)).toEqual(keep);
    expect(Object.keys(kept.settings.popups.sites)).toEqual(keep);
    expect(Object.keys(kept.userFilters?.hosts ?? {})).toEqual(['localhost', 'a.example']);
    expect(JSON.stringify(input)).toBe(before);
  });

  test('a backup without such hosts comes back as it was; no filters stay none', () => {
    const input = backup(['example.com'], null);
    const out = withoutSuffixHosts(input, NO_DEVICE_HOSTS);
    expect(out.hosts).toEqual([]);
    expect(out.backup).toEqual(input);
  });
});

/**
 * D-62 (design review, 2026-11-14): the drop stays the default, with one exception: a single-label host in the file is
 * kept when the device's current settings already hold that same host in the same collection (a same-device
 * round trip of `nas` must not lose it). Two-label suffixes are never kept; the preview names what is dropped.
 */
describe('withoutSuffixHosts against the device (D-62)', () => {
  const device = (levels: readonly string[], popups: readonly string[], filters: readonly string[]): DeviceHosts => {
    const settings = {
      siteLevels: Object.fromEntries(levels.map((h) => [h, 'off'])) as Settings['siteLevels'],
      popups: { ...base.popups, sites: Object.fromEntries(popups.map((h) => [h, 'allow'])) as Settings['popups']['sites'] },
    };
    return deviceHostsOf(settings, { v: 1, hosts: Object.fromEntries(filters.map((h) => [h, ['body']])) });
  };

  test('a same-device round trip keeps nas in every collection that already holds it', () => {
    const input = backup(['nas', 'example.com'], ['nas']);
    const { backup: kept, hosts } = withoutSuffixHosts(input, device(['nas'], ['nas'], ['nas']));
    expect(hosts).toEqual([]);
    expect(kept).toEqual(input);
  });

  test('an empty device drops nas from every collection and names it', () => {
    const { backup: kept, hosts } = withoutSuffixHosts(backup(['nas', 'example.com'], ['nas']), device([], [], []));
    expect(hosts).toEqual(['nas']);
    expect(Object.keys(kept.settings.siteLevels)).toEqual(['example.com']);
    expect(Object.keys(kept.settings.popups.sites)).toEqual(['example.com']);
    expect(Object.keys(kept.userFilters?.hosts ?? {})).toEqual([]);
  });

  test('com absent from the device is still dropped while nas on the device is kept', () => {
    const { backup: kept, hosts } = withoutSuffixHosts(backup(['com', 'nas'], ['com', 'nas']), device(['nas'], ['nas'], ['nas']));
    expect(hosts).toEqual(['com']);
    expect(Object.keys(kept.settings.siteLevels)).toEqual(['nas']);
    expect(Object.keys(kept.userFilters?.hosts ?? {})).toEqual(['nas']);
  });

  test('the same collection only: nas held as a site level does not let a pop-up choice or a hidden item for nas in', () => {
    const { backup: kept, hosts } = withoutSuffixHosts(backup(['nas'], ['nas']), device(['nas'], [], []));
    expect(hosts).toEqual(['nas']);
    expect(Object.keys(kept.settings.siteLevels)).toEqual(['nas']);
    expect(Object.keys(kept.settings.popups.sites)).toEqual([]);
    expect(Object.keys(kept.userFilters?.hosts ?? {})).toEqual([]);
  });

  test('a two-label suffix is dropped even when the device holds it', () => {
    const { hosts } = withoutSuffixHosts(backup(['co.uk'], ['co.uk']), device(['co.uk'], ['co.uk'], ['co.uk']));
    expect(hosts).toEqual(['co.uk']);
  });

  test('without readable device filters, no hidden-item host is kept on their account', () => {
    const settings = { ...base, siteLevels: { nas: 'off' as const } };
    const { hosts } = withoutSuffixHosts(backup([], ['nas']), deviceHostsOf(settings, null));
    expect(hosts).toEqual(['nas']);
  });

  test('a __proto__ key from the file is an own entry, dropped like any single label the device does not hold', () => {
    const input = JSON.parse('{"__proto__":"off","example.com":"off"}') as Record<string, 'off'>;
    const { backup: kept, hosts } = withoutSuffixHosts({ ...backup([], null), settings: { ...backup([], null).settings, siteLevels: input } }, device(['nas'], [], []));
    expect(hosts).toEqual(['__proto__']);
    expect(Object.keys(kept.settings.siteLevels)).toEqual(['example.com']);
    expect(Object.getPrototypeOf(kept.settings.siteLevels)).toBe(Object.prototype);
  });
});
