/**
 * Ruleset-only repack (update-strategy notes §3.2, ADR-008, S-08, P2-01): the published zip plus new **safe** ruleset
 * files → candidate zip. Every other entry keeps its compressed bytes; in `manifest.json` only the bytes of
 * the `version` value change. Refuses `-x` files (frozen between full releases, D-06), paths outside
 * `rule_resources`, a version that is not later than the base or changes the code line, and a manifest
 * whose version cannot be rewritten without touching anything else.
 */
import { compareVersions, decodeVersion } from '../../src/core/version.js';
import { MANIFEST_PATH, manifestOf, UNSAFE_SUFFIX, withVersion, type PackagedManifest } from './manifest.js';
import { readZip, writeZip, type ZipEntry } from './zip.js';

export interface RepackInput {
  /** The published full-release zip (or, for now, the locally built release zip). */
  readonly base: Uint8Array;
  /** Zip path → new bytes; only safe `rule_resources` paths. */
  readonly rulesets: ReadonlyMap<string, Uint8Array>;
  /** Candidate version, in the `MAJOR.MINOR.RULES_DAY.RULES_HHMM` scheme. */
  readonly version: string;
}

/** Safe ruleset paths declared by `zip`'s manifest, sorted: what a ruleset release may replace. */
export function safeRulesetPaths(zip: Uint8Array): readonly string[] {
  return manifestOf(readZip(zip)).ruleResources.filter((r) => !r.id.endsWith(UNSAFE_SUFFIX)).map((r) => r.path).sort();
}

function checkVersion(base: string, candidate: string): void {
  const next = decodeVersion(candidate);
  if (next === undefined) throw new Error(`candidate version ${candidate} is outside the MAJOR.MINOR.RULES_DAY.RULES_HHMM scheme`);
  const [major = 0, minor = 0] = base.split('.').map(Number);
  if (next.major !== major || next.minor !== minor) throw new Error(`candidate ${candidate} changes the code line of ${base} (only a full release may)`);
  if (compareVersions(candidate, base) <= 0) throw new Error(`candidate ${candidate} is not later than the base ${base}`);
}

function checkPaths(manifest: PackagedManifest, entries: readonly ZipEntry[], paths: readonly string[]): void {
  const byPath = new Map(manifest.ruleResources.map((r) => [r.path, r]));
  const present = new Set(entries.map((e) => e.path));
  for (const p of paths) {
    const r = byPath.get(p);
    if (r === undefined) throw new Error(`not a rule_resources path: ${p}`);
    if (r.id.endsWith(UNSAFE_SUFFIX)) throw new Error(`${p} is a -x ruleset: unsafe rules change only in a full release`);
    if (!present.has(p)) throw new Error(`${p} is declared but not in the base zip`);
  }
}

/** The rewritten manifest, checked: it parses to the new version and is otherwise the same JSON. */
function rewriteVersion(manifest: PackagedManifest, version: string): string {
  const text = withVersion(manifest, version);
  const next = manifestOf([{ path: MANIFEST_PATH, data: new TextEncoder().encode(text) }]);
  if (next.version !== version) throw new Error('the "version" key that was rewritten is not the manifest version');
  return text;
}

/** Builds the candidate zip. Throws on any input a ruleset release must not carry. */
export function repack(input: RepackInput): Uint8Array {
  const entries = readZip(input.base);
  const manifest = manifestOf(entries);
  checkVersion(manifest.version, input.version);
  checkPaths(manifest, entries, [...input.rulesets.keys()]);
  const nextManifest = new TextEncoder().encode(rewriteVersion(manifest, input.version));
  return writeZip(entries.map((e): ZipEntry => {
    if (e.path === MANIFEST_PATH) return { path: e.path, data: nextManifest };
    const replacement = input.rulesets.get(e.path);
    // Identical content keeps the published compressed bytes too.
    return replacement === undefined || Buffer.from(replacement).equals(Buffer.from(e.data)) ? e : { path: e.path, data: replacement };
  }));
}
