/**
 * Generic cosmetic data (P2-23, cosmetic notes §5, ADR-010 after S-04): the contract between the compiler,
 * which writes one packaged file per pack (`cosmetic/<pack>/generic.js`), and the `cosmetic-generic`
 * surveyor (P2-24), which takes the queue. The data is packaged and listed in the registration; it is
 * never stored by the worker. Pure and dependency-free: the surveyor imports it.
 */
import { parentDomains } from '../hostname/walk.js';
import type { Hostname } from '../ids.js';
import { leadingToken, tokenHash } from './token.js';

export const GENERIC_DATA_VERSION = 1;
/** Queue a generic data file pushes onto. Property name only; no product name (brand.ts). */
export const GENERIC_QUEUE = '__cg_q';

export interface GenericData {
  readonly v: typeof GENERIC_DATA_VERSION;
  readonly pack: string;
  /** Sorted, sanitised plain-CSS selectors of this pack. */
  readonly selectors: readonly string[];
  /** `tokenHash(leadingToken(selector))` → indices into `selectors`. */
  readonly tokens: Readonly<Record<string, readonly number[]>>;
  /** Selectors without a leading token: applied on every Thorough page. Indices into `selectors`. */
  readonly always: readonly number[];
  /** Host-less `#@#` exceptions of this pack: subtracted from every loaded pack at run time. */
  readonly unhide: readonly string[];
  /** `host#@#selector` and `~host##selector` exceptions, sorted by host; host and parents subtract. */
  readonly exceptions: readonly (readonly [string, readonly string[]])[];
  /** Hosts switched off by `$generichide` / `$elemhide`, sorted; sub-hosts included. */
  readonly off: readonly string[];
}

/** Packaged path of a pack's generic data. */
export const genericDataPath = (pack: string): string => `cosmetic/${pack}/generic.js`;

/** Prefix and suffix of a generic data file around its JSON literal. */
export function genericFileWrap(): { readonly prefix: string; readonly suffix: string } {
  return { prefix: `(self.${GENERIC_QUEUE}=self.${GENERIC_QUEUE}||[]).push(`, suffix: ');\n' };
}

/** Selectors keyed on exactly `token` (`.ad`, `#top`); a hash collision is filtered out. One hash per call (P3-17). */
export function lookupToken(data: GenericData, token: string): readonly string[] {
  const key = String(tokenHash(token));
  if (!Object.hasOwn(data.tokens, key)) return [];
  const out: string[] = [];
  for (const i of data.tokens[key] ?? []) {
    const selector = data.selectors[i] ?? '';
    if (leadingToken(selector) === token) out.push(selector);
  }
  return out;
}

const sortedHas = (list: readonly string[], value: string): boolean => {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = list[mid] ?? '';
    if (at === value) return true;
    if (at < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
};

/** Exception selectors for `host` and its parents. */
export function exceptionsFor(data: GenericData, host: Hostname): readonly string[] {
  const chain = new Set<string>(parentDomains(host));
  return [...new Set(data.exceptions.filter(([h]) => chain.has(h)).flatMap(([, selectors]) => selectors))];
}

/** True when generic hiding is switched off on `host` or a parent. */
export function isGenericOff(data: GenericData, host: Hostname): boolean {
  return parentDomains(host).some((h) => sortedHas(data.off, h));
}

const isRecord = (x: unknown): x is Readonly<Record<string, unknown>> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStrings = (x: unknown): x is readonly string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');
const isIndices = (x: unknown, size: number): boolean =>
  Array.isArray(x) && x.every((i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < size);
const isSortedUnique = (list: readonly string[]): boolean => list.every((s, i) => i === 0 || (list[i - 1] ?? '') < s);

function isExceptions(x: unknown): boolean {
  if (!Array.isArray(x)) return false;
  const rows: readonly unknown[] = x;
  const valid = rows.every((r) => Array.isArray(r) && r.length === 2 && typeof r[0] === 'string' && isStrings(r[1]));
  return valid && isSortedUnique(rows.map((r) => (r as readonly [string])[0]));
}

/** Shape guard for one queued datum (own data properties only, every index in range). */
export function isGenericData(x: unknown): x is GenericData {
  if (!isRecord(x) || x['v'] !== GENERIC_DATA_VERSION || typeof x['pack'] !== 'string' || !isStrings(x['selectors'])) return false;
  const size = x['selectors'].length;
  const tokens = x['tokens'];
  return isRecord(tokens) && Object.values(tokens).every((list) => isIndices(list, size)) && isIndices(x['always'], size)
    && isStrings(x['unhide']) && isExceptions(x['exceptions']) && isStrings(x['off']) && isSortedUnique(x['off']);
}
