/**
 * P2-43 security review (A-1), design review: a backup file is untrusted input, and an entry for a whole suffix
 * (`com`, `co.uk`, or any single label but `localhost`) would switch blocking Off, allow pop-ups or hide
 * elements on every site under it. A restore drops such entries from the site levels, the pop-up choices
 * and the hidden items, and the preview names each dropped host; the rest restores as usual. Without a
 * Public Suffix List, `isSuffix` knows ~45 two-label suffixes (residual risk: `github.io` and the like
 * pass; the preview's warnings name every weakened host).
 * D-62 (design review): one exception. A single-label host (`nas`) is kept when the device's current settings
 * already hold that same host in the same collection, so a same-device round trip loses nothing; the file
 * cannot widen anything the device does not already have there. Two-label suffixes are always dropped. Pure.
 */
import type { Hostname } from '../ids.js';
import { isSuffix } from '../popup/site.js';
import type { UserFilters } from '../userFilters/store.js';
import type { Backup } from './backup.js';
import type { Settings } from './types.js';

const KEPT_SINGLE_LABEL = 'localhost';

/** The hosts the device's current settings hold, per collection a backup can restore (D-62). */
export interface DeviceHosts {
  readonly siteLevels: ReadonlySet<string>;
  readonly popups: ReadonlySet<string>;
  readonly userFilters: ReadonlySet<string>;
}

export const NO_DEVICE_HOSTS: DeviceHosts = { siteLevels: new Set(), popups: new Set(), userFilters: new Set() };

/** The device's hosts from its current settings and hidden items (`null`: none known, nothing kept on their account). */
export function deviceHostsOf(settings: Pick<Settings, 'siteLevels' | 'popups'>, filters: UserFilters | null): DeviceHosts {
  return {
    siteLevels: new Set(Object.keys(settings.siteLevels)),
    popups: new Set(Object.keys(settings.popups.sites)),
    userFilters: new Set(Object.keys(filters?.hosts ?? {})),
  };
}

const coversASuffix = (host: string): boolean => host !== KEPT_SINGLE_LABEL && isSuffix(host);

const isSingleLabel = (host: string): boolean => !host.includes('.');

/** Dropped unless it is a single label the device already holds in this collection (D-62). */
const drops = (host: string, onDevice: ReadonlySet<string>): boolean => coversASuffix(host) && !(isSingleLabel(host) && onDevice.has(host));

function split<V>(map: Readonly<Record<Hostname, V>>, onDevice: ReadonlySet<string>): { readonly kept: Readonly<Record<Hostname, V>>; readonly dropped: readonly Hostname[] } {
  const entries = Object.entries(map) as [Hostname, V][];
  return {
    kept: Object.fromEntries(entries.filter(([host]) => !drops(host, onDevice))),
    dropped: entries.filter(([host]) => drops(host, onDevice)).map(([host]) => host),
  };
}

/** `backup` without entries for a whole suffix (but D-62's), and the hosts dropped (sorted, each once). New objects. */
export function withoutSuffixHosts(backup: Backup, device: DeviceHosts): { readonly backup: Backup; readonly hosts: readonly Hostname[] } {
  const { settings, userFilters } = backup;
  const levels = split(settings.siteLevels, device.siteLevels);
  const popups = split(settings.popups.sites, device.popups);
  const filters = userFilters === null ? null : split(userFilters.hosts, device.userFilters);
  const hosts = [...new Set([...levels.dropped, ...popups.dropped, ...(filters?.dropped ?? [])])].sort();
  if (hosts.length === 0) return { backup, hosts };
  return {
    backup: {
      settings: { ...settings, siteLevels: levels.kept, popups: { ...settings.popups, sites: popups.kept } },
      userFilters: userFilters === null || filters === null ? null : { ...userFilters, hosts: filters.kept },
    },
    hosts,
  };
}
