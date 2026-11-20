/**
 * Entity forms (`google.*`, P1-03). Entities cannot be written as match patterns, so the compiler
 * expands them against a suffix table (cosmetic notes §6.2); `entityFormsOf` is the reverse used by lookups
 * and tests. The public suffix is supplied by the caller: core carries no public-suffix list.
 */
import type { Hostname } from '../ids.js';
import { parseHostname } from './validate.js';
import { parentDomains } from './walk.js';

const ENTITY_SUFFIX = '.*';

/** True for `name.*` where `name` is a valid hostname. */
export function isEntityPattern(pattern: string): boolean {
  return pattern.endsWith(ENTITY_SUFFIX) && parseHostname(pattern.slice(0, -ENTITY_SUFFIX.length)) !== null;
}

/**
 * Entity forms of `host` given its public suffix: `www.google.co.uk` with `co.uk` →
 * `www.google.*`, `google.*`. Empty when `publicSuffix` is not a proper suffix of `host`.
 */
export function entityFormsOf(host: Hostname, publicSuffix: Hostname): readonly string[] {
  const tail = `.${publicSuffix}`;
  return parentDomains(host)
    .filter((name) => name.endsWith(tail) && name.length > tail.length)
    .map((name) => `${name.slice(0, -tail.length)}${ENTITY_SUFFIX}`);
}

/** Expands `name.*` against `suffixes`; results that are not valid hostnames are dropped. */
export function expandEntity(entity: string, suffixes: readonly string[]): readonly Hostname[] {
  if (!isEntityPattern(entity)) return [];
  const name = entity.slice(0, -ENTITY_SUFFIX.length);
  return suffixes.flatMap((suffix) => {
    const host = parseHostname(`${name}.${suffix}`);
    return host ? [host] : [];
  });
}
