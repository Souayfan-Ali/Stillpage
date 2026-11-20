/**
 * The `storage.local` mirror of the user filters (P2-20, architecture notes §6): `uf:<hostname>` = `{ v: 1, s }`.
 * Content scripts can read **and write** `storage.local`, so the `user-cosmetic` script treats an entry
 * as untrusted (`readMirrorEntry`: shape guard, sanitised selectors, `display:none` only), and the worker
 * re-derives the mirror from the vault (`auditMirror`) on every reconcile and on a daily alarm.
 */
import type { Hostname } from '../ids.js';
import { cleanSelectors, type UserFilters } from './store.js';

export const MIRROR_PREFIX = 'uf:';

export interface MirrorEntry {
  readonly v: 1;
  readonly s: readonly string[];
}

export const mirrorKey = (host: Hostname): string => `${MIRROR_PREFIX}${host}`;

/** The mirror the vault implies. */
export function mirrorOf(store: UserFilters): Readonly<Record<string, MirrorEntry>> {
  return Object.fromEntries(Object.entries(store.hosts).map(([host, s]) => [mirrorKey(host as Hostname), { v: 1, s: [...s] }]));
}

/** Selectors of one mirror entry as the content script may apply them; `[]` for anything malformed. */
export function readMirrorEntry(raw: unknown): readonly string[] {
  if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== 1) return [];
  const s = (raw as { s?: unknown }).s;
  return Array.isArray(s) ? cleanSelectors(s as readonly unknown[]) : [];
}

const same = (a: unknown, b: MirrorEntry): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Writes and deletions that make `actual` (all of `storage.local`) match the vault. */
export function auditMirror(store: UserFilters, actual: Readonly<Record<string, unknown>>): { readonly set: Readonly<Record<string, MirrorEntry>>; readonly remove: readonly string[] } {
  const wanted = mirrorOf(store);
  const set = Object.fromEntries(Object.entries(wanted).filter(([key, entry]) => !Object.hasOwn(actual, key) || !same(actual[key], entry)));
  const remove = Object.keys(actual).filter((key) => key.startsWith(MIRROR_PREFIX) && !Object.hasOwn(wanted, key)).sort();
  return { set, remove };
}
