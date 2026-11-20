/**
 * The user's element-hider filters (P2-20, cosmetic notes §7, architecture notes §6): authoritative in the vault under
 * `userFilters`, one sorted list of sanitised selectors per hostname. A filter saved on host H hides on
 * H and its subdomains (uBO's `H##sel`). Pure; every change returns a new object.
 */
import { parseHostname } from '../hostname/validate.js';
import type { Hostname } from '../ids.js';
import { own } from '../record.js';
import { err, ok, type Result } from '../result.js';
import { sanitiseSelector } from '../sanitise/selector.js';

/** Vault key of the store. */
export const USER_FILTERS_KEY = 'userFilters';
export const MAX_SELECTORS_PER_HOST = 100;
export const MAX_HOSTS = 2_000;

export interface UserFilters {
  readonly v: 1;
  readonly hosts: Readonly<Record<Hostname, readonly string[]>>;
}

export const EMPTY_USER_FILTERS: UserFilters = Object.freeze({ v: 1, hosts: Object.freeze({}) });

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

/** Selectors of a list that pass the sanitiser unchanged, de-duplicated, sorted, capped. */
export function cleanSelectors(raw: readonly unknown[]): readonly string[] {
  const safe = raw.filter((s): s is string => typeof s === 'string' && sanitiseSelector(s) === s);
  return sortedUnique(safe).slice(0, MAX_SELECTORS_PER_HOST);
}

/** The vault value validated; anything malformed is dropped (the vault is ours, but never trusted blindly). */
export function readUserFilters(raw: unknown): UserFilters {
  if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== 1) return EMPTY_USER_FILTERS;
  const hosts = (raw as { hosts?: unknown }).hosts;
  if (typeof hosts !== 'object' || hosts === null) return EMPTY_USER_FILTERS;
  const entries = Object.entries(hosts).flatMap(([host, list]): [Hostname, readonly string[]][] => {
    const name = parseHostname(host);
    const clean = Array.isArray(list) ? cleanSelectors(list as readonly unknown[]) : [];
    return name === null || name !== host || clean.length === 0 ? [] : [[name, clean]];
  });
  return { v: 1, hosts: Object.fromEntries(entries.slice(0, MAX_HOSTS)) };
}

/** True when a stored value exists but is not a store this build can read (then nothing is overwritten). */
export function isUnreadableStore(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== 'object' || raw === null) return true;
  const r = raw as { v?: unknown; hosts?: unknown };
  return r.v !== 1 || typeof r.hosts !== 'object' || r.hosts === null;
}

/** Adds `selector` on `host`; refuses an unsafe selector or one past the caps. */
export function addUserFilter(store: UserFilters, host: Hostname, selector: string): Result<UserFilters> {
  const safe = sanitiseSelector(selector);
  if (safe === null) return err(['selector refused']);
  const current = own(store.hosts, host) ?? [];
  if (current.includes(safe)) return ok(store);
  if (current.length >= MAX_SELECTORS_PER_HOST) return err(['too many filters on this site']);
  if (current.length === 0 && Object.keys(store.hosts).length >= MAX_HOSTS) return err(['too many sites with filters']);
  return ok({ v: 1, hosts: { ...store.hosts, [host]: sortedUnique([...current, safe]) } });
}

/** Removes `selector` from `host` (and the host when it was its last); unchanged when absent. */
export function removeUserFilter(store: UserFilters, host: Hostname, selector: string): UserFilters {
  const current = own(store.hosts, host);
  if (current?.includes(selector) !== true) return store;
  const rest = current.filter((s) => s !== selector);
  const others = Object.fromEntries(Object.entries(store.hosts).filter(([h]) => h !== host));
  return { v: 1, hosts: (rest.length === 0 ? others : { ...others, [host]: rest }) };
}

/**
 * The key a filter is stored under: the page's hostname without a leading `www.` (design review; no Public
 * Suffix List), so a filter picked on `www.example.com` also hides on `example.com` and its subdomains.
 */
export function filterHostKey(host: Hostname): Hostname {
  const bare = host.startsWith('www.') ? parseHostname(host.slice(4)) : null;
  return bare?.includes('.') === true ? bare : host;
}

/** Hosts with filters, sorted (the `user-cosmetic` registration's hosts). */
export function filterHosts(store: UserFilters): readonly Hostname[] {
  return (Object.keys(store.hosts) as Hostname[]).sort();
}
