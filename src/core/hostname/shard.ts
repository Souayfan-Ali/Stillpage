/**
 * Shard key and sharded lookup (P1-03, cosmetic notes §2.1, S-04): FNV-1a (32-bit) of the last two labels,
 * modulo `SHARD_COUNT`. No public-suffix list is needed, and a host shares its shard with every
 * parent of two or more labels. Dependency-free.
 */
import type { Hostname } from '../ids.js';
import { SHARD_COUNT } from '../limits.js';
import { parentDomains } from './walk.js';

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const SHARD_LABELS = 2;

/** Shard of a host: identical for `www.example.com` and `example.com`. */
export function shardKey(host: Hostname): number {
  const tail = host.split('.').slice(-SHARD_LABELS).join('.');
  let hash = FNV_OFFSET;
  for (let i = 0; i < tail.length; i += 1) hash = Math.imul(hash ^ tail.charCodeAt(i), FNV_PRIME);
  return (hash >>> 0) % SHARD_COUNT;
}

/** Entries grouped by shard, then by host. */
export type Shards<T> = ReadonlyMap<number, ReadonlyMap<Hostname, readonly T[]>>;

/** Groups `(host, value)` entries by shard key. Builds new maps; the input is not touched. */
export function shardEntries<T>(entries: readonly (readonly [Hostname, T])[]): Shards<T> {
  const shards = new Map<number, Map<Hostname, T[]>>();
  for (const [host, value] of entries) {
    const key = shardKey(host);
    const shard = shards.get(key) ?? new Map<Hostname, T[]>();
    shard.set(host, [...(shard.get(host) ?? []), value]);
    shards.set(key, shard);
  }
  return shards;
}

/**
 * Every value stored for `host` or one of its parents. Each parent is looked up in its own shard,
 * so single-label keys (which hash differently from their subdomains) are found too.
 */
export function lookupSharded<T>(shards: Shards<T>, host: Hostname): readonly T[] {
  return parentDomains(host).flatMap((name) => shards.get(shardKey(name))?.get(name) ?? []);
}
