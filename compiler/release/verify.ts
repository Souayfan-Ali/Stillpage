/**
 * Published-package check (tooling notes §8, P2-07): the store re-signs the package, so the CRX it serves never
 * matches our zip byte for byte. We compare unpacked contents instead: every file's SHA-256 against the
 * release record, `manifest.json` as JSON against the release zip's, ignoring what the store adds.
 * What the store adds is UNVERIFIED until S-12: `_metadata/` (verified contents) and the manifest keys
 * `update_url` and `key` are assumed; anything else counts as a mismatch.
 */
import { MANIFEST_PATH, manifestOf } from './manifest.js';
import { sha256Hex, type ReleaseRecord } from './record.js';
import { readZip } from './zip.js';

const CRX_MAGIC = 'Cr24';
const CRX_VERSION = 3;
const CRX_PREFIX = 12;
const STORE_DIR = '_metadata/';
const STORE_MANIFEST_KEYS: ReadonlySet<string> = new Set(['update_url', 'key']);

export interface StoreComparison {
  readonly match: boolean;
  readonly problems: readonly string[];
}

/** The zip inside a CRX3 file (magic, version 3, header length, signed header, zip). */
export function zipOfCrx(crx: Uint8Array): Uint8Array {
  const buf = Buffer.from(crx.buffer, crx.byteOffset, crx.byteLength);
  if (buf.length < CRX_PREFIX || buf.subarray(0, 4).toString('latin1') !== CRX_MAGIC || buf.readUInt32LE(4) !== CRX_VERSION) throw new Error('not a CRX3 file');
  const end = CRX_PREFIX + buf.readUInt32LE(8);
  if (end > buf.length) throw new Error('CRX3 header runs past the end');
  return new Uint8Array(buf.subarray(end));
}

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])]));
};
const withoutStoreKeys = (json: unknown): string =>
  JSON.stringify(sorted(Object.fromEntries(Object.entries(json as object).filter(([k]) => !STORE_MANIFEST_KEYS.has(k)))));

/** Compares the published package's zip with the release zip and its record. */
export function compareWithRecord(record: ReleaseRecord, releaseZip: Uint8Array, publishedZip: Uint8Array): StoreComparison {
  if (sha256Hex(releaseZip) !== record.zipSha256) return { match: false, problems: ['the release zip is not the recorded one'] };
  const ours = manifestOf(readZip(releaseZip));
  const entries = readZip(publishedZip).filter((e) => !e.path.startsWith(STORE_DIR));
  const theirs = manifestOf(entries);
  if (theirs.version !== record.version) return { match: false, problems: [`version: published ${theirs.version}, record ${record.version}`] };
  const published = new Map(entries.map((e) => [e.path, sha256Hex(e.data)]));
  const problems = [
    ...[...published.keys()].filter((p) => !Object.hasOwn(record.files, p)).sort().map((p) => `extra: ${p}`),
    ...Object.keys(record.files).filter((p) => !published.has(p)).sort().map((p) => `missing: ${p}`),
    ...Object.entries(record.files).filter(([p, h]) => p !== MANIFEST_PATH && published.has(p) && published.get(p) !== h).map(([p]) => `changed: ${p}`).sort(),
    ...(withoutStoreKeys(theirs.json) === withoutStoreKeys(ours.json) ? [] : ["changed: manifest.json (beyond the store's update_url / key)"]),
  ];
  return { match: problems.length === 0, problems };
}
