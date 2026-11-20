/**
 * The hidden-items list (P2-22, UI notes §5, §8): the user filters as rows per site for the dashboard,
 * and how many apply on one host for the toolbar panel's footer. A filter saved on H hides on H and its
 * subdomains, so a host lists its own filters and its parents' (the `user-cosmetic` walk). Pure;
 * dependency-free.
 */
import { parentDomains } from '../hostname/walk.js';
import type { Hostname } from '../ids.js';
import { own } from '../record.js';
import type { UserFilters } from './store.js';

/** Most parent keys one frame reads (as `user-cosmetic`). */
export const MAX_KEYS = 8;

export interface HiddenSite {
  readonly host: Hostname;
  readonly selectors: readonly string[];
}

/** Distinct filters that apply on `host`, sorted; none without a host (P2-22 count, P2-22b list). */
export function selectorsOn(store: UserFilters, host: Hostname | null): readonly string[] {
  if (host === null) return [];
  const keys = parentDomains(host).slice(0, MAX_KEYS);
  return [...new Set(keys.flatMap((key) => own(store.hosts, key) ?? []))].sort();
}

/** One row per site, sorted by host. */
export function hiddenSites(store: UserFilters): readonly HiddenSite[] {
  return (Object.keys(store.hosts) as Hostname[]).sort().map((host) => ({ host, selectors: own(store.hosts, host) ?? [] }));
}

/** The store of a list of rows (backup export from the dashboard). */
export function storeOfSites(sites: readonly HiddenSite[]): UserFilters {
  return { v: 1, hosts: Object.fromEntries(sites.map((s) => [s.host, [...s.selectors]])) };
}
