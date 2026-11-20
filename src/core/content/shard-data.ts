/**
 * Inline shard data (ADR-010 as amended, cosmetic notes §2.1, §6.2): the contract between the compiler,
 * which writes one data file per (pack, world, shard), and the registered content scripts that read
 * it (P1-34, P1-36, P1-37). A data file is a classic script that appends one `ShardData` literal to
 * a queue on `self`; the script registered after it in the same registration takes the queue.
 * Pure and dependency-free: content scripts import it.
 */
import type { Hostname } from '../ids.js';
import { parentDomains } from '../hostname/walk.js';

/** Data schema version; a reader ignores data of another version. */
export const SHARD_DATA_VERSION = 1;
/** Queue a data file pushes onto, per world. Property names only; no product name (brand.ts). */
export const SHARD_QUEUE = { ISOLATED: '__cs_q', MAIN: '__sl_q' } as const;

/**
 * What one host carries. Every field holds indices into the shard's tables and is omitted when empty.
 * `u` and `n` hold exceptions: they cancel the same entries inherited from a parent host.
 */
export interface HostEntry {
  /** Selectors hidden with `display:none!important` (`selectors`). */
  readonly h?: readonly number[];
  /** Selectors un-hidden here and below (`#@#`, `~host` in a filter's domain list). */
  readonly u?: readonly number[];
  /** `:style()` rules (`styles`). */
  readonly s?: readonly number[];
  /** Procedural programs (`procedural`). */
  readonly p?: readonly number[];
  /** Scriptlet invocations (`invocations`). */
  readonly j?: readonly number[];
  /** Scriptlet invocations cancelled here and below. */
  readonly n?: readonly number[];
}

export interface ShardData {
  readonly v: typeof SHARD_DATA_VERSION;
  readonly pack: string;
  readonly shard: number;
  /** Sorted hostnames; `entries[i]` belongs to `hosts[i]`. */
  readonly hosts: readonly Hostname[];
  readonly entries: readonly HostEntry[];
  readonly selectors: readonly string[];
  /** `[selector, declarations]`, both through `core/sanitise` at build time. */
  readonly styles: readonly (readonly [string, string])[];
  /** uBO procedural programs, as uBO's selector compiler emits them (JSON text, ADR-005). */
  readonly procedural: readonly string[];
  /**
   * `[function index in the pack's code file, ...JSON arguments]`. An index `i` in `j` / `n` refers to
   * `invocations[i]` when `i >= 0`, else to `common.invocations[~i]` of the same pack and world.
   */
  readonly invocations: readonly Invocation[];
}

export type Invocation = readonly [number, ...string[]];

/** Invocations used in more than one shard of a pack and world, packaged once (`commonDataPath`). */
export interface CommonData {
  readonly v: typeof SHARD_DATA_VERSION;
  readonly pack: string;
  readonly common: true;
  readonly invocations: readonly Invocation[];
}

/** Effective indices for one field on `host`: inherited from every parent, minus cancelled ones. */
export interface HostLookup {
  readonly selectors: readonly number[];
  readonly styles: readonly number[];
  readonly procedural: readonly number[];
  readonly invocations: readonly number[];
}

function entryOf(data: ShardData, host: Hostname): HostEntry | undefined {
  let lo = 0;
  let hi = data.hosts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = data.hosts[mid] ?? '';
    if (at === host) return data.entries[mid];
    if (at < host) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

const union = (lists: readonly (readonly number[] | undefined)[]): Set<number> => new Set(lists.flatMap((l) => l ?? []));
const sorted = (set: ReadonlySet<number>, minus: ReadonlySet<number> = new Set()): number[] =>
  [...set].filter((i) => !minus.has(i)).sort((a, b) => a - b);

/** Looks up `host` and its parents (binary search per name). Builds new arrays; `data` is untouched. */
export function lookupHost(data: ShardData, host: Hostname): HostLookup {
  const found = parentDomains(host).map((name) => entryOf(data, name)).filter((e): e is HostEntry => e !== undefined);
  return {
    selectors: sorted(union(found.map((e) => e.h)), union(found.map((e) => e.u))),
    styles: sorted(union(found.map((e) => e.s))),
    procedural: sorted(union(found.map((e) => e.p))),
    invocations: sorted(union(found.map((e) => e.j)), union(found.map((e) => e.n))),
  };
}

/**
 * MAIN data files (P1-37, design review, security review M1): the datum goes into a null-prototype holder at a
 * fixed slot (`s` shard, `c` common), never `push`ed onto an array the page could have made. The first
 * file of a registration (`first`) deletes whatever sits at the key and creates a fresh holder, so a
 * holder a same-origin parent planted in a fresh realm (frozen, Proxy) is never adopted; when the key
 * cannot be deleted it writes nothing. Later files of the same registration adopt that fresh holder
 * (no page script runs between our files); a slot already taken marks it tampered (`x`). The dispatcher
 * runs nothing for a holder that is missing, odd or tampered (fail closed).
 */
const MAIN_PREFIX = (key: string, first: boolean): string =>
  `(function(d){var s=self,k=${JSON.stringify(key)},O=Object,q,h;` +
  (first
    ? 'if(!Reflect.deleteProperty(s,k))return;q=O.create(null);O.defineProperty(s,k,{value:q,configurable:true,writable:false,enumerable:false});'
    : 'h=O.getOwnPropertyDescriptor(s,k);if(h===void 0||!("value"in h)||!h.configurable||h.value===null||typeof h.value!=="object"||O.getPrototypeOf(h.value)!==null||!O.isExtensible(h.value))return;q=h.value;') +
  'var n=d!==null&&typeof d==="object"&&d.common===true?"c":"s";if(O.getOwnPropertyDescriptor(q,n)!==void 0)q.x=true;else q[n]=d;})(';

/** Prefix and suffix of a data file around its JSON literal (the compiler writes, tests parse back). */
export function shardFileWrap(world: keyof typeof SHARD_QUEUE, first = false): { readonly prefix: string; readonly suffix: string } {
  if (world === 'MAIN') return { prefix: MAIN_PREFIX(SHARD_QUEUE.MAIN, first), suffix: ');\n' };
  return { prefix: `(self.${SHARD_QUEUE[world]}=self.${SHARD_QUEUE[world]}||[]).push(`, suffix: ');\n' };
}
