import { isSuffixLike } from './hosts.js';

/**
 * Observed expansion of entity hostnames (D-20, P1-51): `name.*` cannot be a match pattern or a DNR
 * domain, so it becomes the `name.<suffix>` hosts (suffix of one or two labels) that some filter of
 * the build already names. Names with no observed host are returned as losses for the build report.
 */

const ENTITY = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.\*$/;
/** Longest public suffix we accept after the stem (`co.uk`, `com.au`). */
const MAX_SUFFIX_LABELS = 2;

/** True for an entity form such as `google.*`. */
export const isEntity = (d: string): boolean => ENTITY.test(d);

export interface Expansion {
  /** Sorted, de-duplicated hosts. */
  readonly hosts: readonly string[];
  /** Entity names that matched no observed host. */
  readonly lost: readonly string[];
}

/** Index of observed hosts by stem (`www.google` → `www.google.de`, …). Build once per build. */
export function stemIndex(hosts: Iterable<string>): ReadonlyMap<string, readonly string[]> {
  const byStem = new Map<string, string[]>();
  for (const h of new Set(hosts)) {
    const labels = h.split('.');
    for (let n = 1; n <= MAX_SUFFIX_LABELS && n < labels.length; n += 1) {
      // Only a public-suffix-like ending: `google.*` must not reach `google.evil.com` (P1-49 review).
      if (!isSuffixLike(labels.slice(-n).join('.'))) continue;
      const stem = labels.slice(0, -n).join('.');
      byStem.set(stem, [...(byStem.get(stem) ?? []), h]);
    }
  }
  return byStem;
}

/** Expands every entity name in `names` against `index`. */
export function expandEntities(names: readonly string[], index: ReadonlyMap<string, readonly string[]>): Expansion {
  const hosts = new Set<string>();
  const lost: string[] = [];
  for (const name of names) {
    const found = index.get(name.slice(0, -2)) ?? [];
    if (found.length === 0) lost.push(name);
    for (const h of found) hosts.add(h);
  }
  return { hosts: [...hosts].sort(), lost: [...new Set(lost)].sort() };
}
