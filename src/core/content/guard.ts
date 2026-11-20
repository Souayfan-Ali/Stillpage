/**
 * Hand-written guards for shard data (CONTRIBUTING.md: content scripts validate with guards, not a schema
 * library). A data file is our own packaged script, but the queue it lands in is a property of the
 * frame's global, so whatever is read back is checked before use: own data properties only (an
 * accessor is never invoked), version, table shapes and every index inside its table.
 */
import { SHARD_DATA_VERSION, type CommonData, type ShardData } from './shard-data.js';

type Rec = Readonly<Record<string, unknown>>;

/** The value of an own data property, never calling a getter; `undefined` otherwise. */
export function ownValue(object: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(object, key);
  return d !== undefined && 'value' in d ? d.value : undefined;
}

const isRecord = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStringArray = (x: unknown): x is readonly string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');
const isInt = (x: unknown): x is number => Number.isInteger(x);

function isSortedUnique(list: readonly string[]): boolean {
  for (let i = 1; i < list.length; i += 1) if ((list[i - 1] ?? '') >= (list[i] ?? '')) return false;
  return true;
}

const isInvocation = (x: unknown): boolean => Array.isArray(x) && x.length >= 1 && isInt(x[0]) && x[0] >= 0 && x.slice(1).every((a) => typeof a === 'string');
const isStylePair = (x: unknown): boolean => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string';

/** Indices of a field must point into `size` entries; `allowCommon` admits negative (`~i`) ones. */
function indicesOk(value: unknown, size: number, allowCommon: boolean): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((i) => isInt(i) && i < size && (i >= 0 || allowCommon));
}

function entryOk(entry: unknown, d: Rec): boolean {
  if (!isRecord(entry)) return false;
  const size = (key: string): number => (ownValue(d, key) as readonly unknown[]).length;
  return indicesOk(ownValue(entry, 'h'), size('selectors'), false)
    && indicesOk(ownValue(entry, 'u'), size('selectors'), false)
    && indicesOk(ownValue(entry, 's'), size('styles'), false)
    && indicesOk(ownValue(entry, 'p'), size('procedural'), false)
    && indicesOk(ownValue(entry, 'j'), size('invocations'), true)
    && indicesOk(ownValue(entry, 'n'), size('invocations'), true);
}

/** True for a well-formed `ShardData` of the current version. */
export function isShardData(x: unknown): x is ShardData {
  if (!isRecord(x) || ownValue(x, 'v') !== SHARD_DATA_VERSION || typeof ownValue(x, 'pack') !== 'string' || !isInt(ownValue(x, 'shard'))) return false;
  const hosts = ownValue(x, 'hosts');
  const entries = ownValue(x, 'entries');
  const styles = ownValue(x, 'styles');
  const invocations = ownValue(x, 'invocations');
  if (!isStringArray(hosts) || !isSortedUnique(hosts) || !Array.isArray(entries) || entries.length !== hosts.length) return false;
  if (!isStringArray(ownValue(x, 'selectors')) || !isStringArray(ownValue(x, 'procedural'))) return false;
  if (!Array.isArray(styles) || !styles.every(isStylePair) || !Array.isArray(invocations) || !invocations.every(isInvocation)) return false;
  return entries.every((e) => entryOk(e, x));
}

/** True for a well-formed pack-wide common invocation table. */
export function isCommonData(x: unknown): x is CommonData {
  if (!isRecord(x) || ownValue(x, 'v') !== SHARD_DATA_VERSION || ownValue(x, 'common') !== true || typeof ownValue(x, 'pack') !== 'string') return false;
  const invocations = ownValue(x, 'invocations');
  return Array.isArray(invocations) && invocations.every(isInvocation);
}

export interface Taken {
  readonly shards: readonly ShardData[];
  readonly common: readonly CommonData[];
}

/**
 * Takes the queue `key` off `scope`: reads it only as an own data property holding an array (never
 * through a getter), keeps the valid items and deletes the property. For the ISOLATED world, which the
 * page cannot reach; the MAIN-world dispatcher (P1-37) has its own hardened reader.
 */
export function takeQueue(scope: object, key: string): Taken {
  const queue = ownValue(scope, key);
  Reflect.deleteProperty(scope, key);
  if (!Array.isArray(queue)) return { shards: [], common: [] };
  const shards: ShardData[] = [];
  const common: CommonData[] = [];
  for (const item of queue as readonly unknown[]) {
    if (isShardData(item)) shards.push(item);
    else if (isCommonData(item)) common.push(item);
  }
  return { shards, common };
}
