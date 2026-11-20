/**
 * File-level checks E1–E5 of the eligibility gate (update-strategy notes §3.3): the base is the published release, and
 * the candidate differs from it only in safe `rule_resources` files and the manifest `version`.
 */
import { compareVersions, decodeVersion } from '../../src/core/version.js';
import { MANIFEST_PATH, UNSAFE_SUFFIX, withVersion, type PackagedManifest } from '../release/manifest.js';
import { sha256Hex, type ReleaseRecord } from '../release/record.js';
import type { ZipEntry } from '../release/zip.js';
import { result, type CheckResult, type StoreState } from './types.js';

/** A zip read once, with its manifest. */
export interface Unpacked {
  readonly bytes: Uint8Array;
  readonly entries: ReadonlyMap<string, ZipEntry>;
  readonly manifest: PackagedManifest;
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b));

/** E1: the base zip is the recorded release, and the store (when known) has that version live. */
export function checkE1(base: Unpacked, record: ReleaseRecord, store: StoreState | undefined): CheckResult {
  const hash = sha256Hex(base.bytes);
  return result('E1', 'abort', [
    ...(hash === record.zipSha256 ? [] : [`base zip SHA-256 ${hash} is not the recorded ${record.zipSha256}`]),
    ...(base.manifest.version === record.version ? [] : [`base version ${base.manifest.version} is not the recorded ${record.version}`]),
    ...(store?.publishedVersion === undefined || store.publishedVersion === record.version ? [] : [`store has ${store.publishedVersion} live, the record says ${record.version}`]),
  ]);
}

/** E2: same file list. */
export function checkE2(base: Unpacked, candidate: Unpacked): CheckResult {
  const added = [...candidate.entries.keys()].filter((p) => !base.entries.has(p));
  const removed = [...base.entries.keys()].filter((p) => !candidate.entries.has(p));
  return result('E2', 'abort', [...added.map((p) => `added: ${p}`), ...removed.map((p) => `removed: ${p}`)]);
}

/** E3: every file outside `rule_resources` byte-identical, `manifest.json` excepted (E4). */
export function checkE3(base: Unpacked, candidate: Unpacked): CheckResult {
  const resources = new Set(base.manifest.ruleResources.map((r) => r.path));
  const changed = [...base.entries].filter(([p, e]) => p !== MANIFEST_PATH && !resources.has(p) && candidate.entries.has(p) && !sameBytes(e.data, candidate.entries.get(p)?.data));
  return result('E3', 'abort', changed.map(([p]) => `changed outside rule_resources: ${p}`));
}

/** JSON with object keys sorted, for a deep comparison that ignores key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const withoutVersion = (json: unknown): string =>
  canonical(typeof json === 'object' && json !== null ? Object.fromEntries(Object.entries(json).filter(([k]) => k !== 'version')) : json);

function versionProblems(base: string, next: string): readonly string[] {
  const v = decodeVersion(next);
  if (v === undefined) return [`candidate version ${next} is outside the scheme`];
  const [major = 0, minor = 0] = base.split('.').map(Number);
  return [
    ...(v.major === major && v.minor === minor ? [] : [`candidate ${next} changes the code line of ${base}`]),
    ...(compareVersions(next, base) > 0 ? [] : [`candidate ${next} is not later than ${base}`]),
  ];
}

/** True when the candidate manifest is byte for byte the base with only the version value rewritten. */
function isVersionOnlyRewrite(base: Unpacked, candidate: Unpacked): boolean {
  try {
    return withVersion(base.manifest, candidate.manifest.version) === candidate.manifest.text;
  } catch {
    return false;
  }
}

/**
 * E4: the manifest deep-diff shows only `version`, and that version is a valid next ruleset version. The bytes
 * must also equal the base with only the version value replaced, so a reordered or duplicate-key manifest
 * (which another JSON parser could read differently) fails.
 */
export function checkE4(base: Unpacked, candidate: Unpacked): CheckResult {
  const same = withoutVersion(base.manifest.json) === withoutVersion(candidate.manifest.json) && isVersionOnlyRewrite(base, candidate);
  return result('E4', 'abort', [
    ...(same ? [] : ['manifest.json differs in more than "version"']),
    ...versionProblems(base.manifest.version, candidate.manifest.version),
  ]);
}

/** E5: every `-x` file byte-identical (unsafe rules ride the full-release train). */
export function checkE5(base: Unpacked, candidate: Unpacked): CheckResult {
  const unsafe = base.manifest.ruleResources.filter((r) => r.id.endsWith(UNSAFE_SUFFIX));
  const changed = unsafe.filter((r) => !sameBytes(base.entries.get(r.path)?.data, candidate.entries.get(r.path)?.data));
  return result('E5', 'route-to-full', changed.map((r) => `-x ruleset changed: ${r.id}`));
}
