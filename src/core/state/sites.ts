/**
 * Removing sites from the dashboard's Sites section (P2-35): every stored choice for each host (level,
 * pause, pop-up policy) goes, so the host inherits again. Pure; returns a new object.
 */
import type { Hostname } from '../ids.js';
import type { Settings } from './types.js';

function without<V>(record: Readonly<Record<Hostname, V>>, hosts: ReadonlySet<string>): Readonly<Record<Hostname, V>> {
  return Object.fromEntries(Object.entries(record).filter(([host]) => !hosts.has(host)));
}

export function withoutSites(settings: Settings, hostnames: readonly Hostname[]): Settings {
  const hosts: ReadonlySet<string> = new Set(hostnames);
  return {
    ...settings,
    siteLevels: without(settings.siteLevels, hosts),
    pauses: without(settings.pauses, hosts),
    popups: { ...settings.popups, sites: without(settings.popups.sites, hosts) },
  };
}
