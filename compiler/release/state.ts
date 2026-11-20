/**
 * Release state (tooling notes §7, P2-05, P2-06): the files of one commit on the orphan `ruleset-state` branch,
 * tagged `rules/<version>`, and the `SHA256SUMS` asset of a GitHub release. Pure: the workflow writes the
 * files and does the git work; for now it only writes them to a directory (dry run, no remote).
 */
import type { ReleaseRecord } from './record.js';
import { sha256Hex } from './record.js';

export interface StateInputs {
  /** `lists/lists.lock.json` text the rulesets were built from. */
  readonly lock: string;
  /** `lists/ruleset-counts.json` text. */
  readonly counts: string;
  /** Slot id → ledger text after the build. */
  readonly ledgers: ReadonlyMap<string, string>;
  /** Record of the candidate that was published. */
  readonly candidate: ReleaseRecord;
  /** Record of the full release it was repacked from. */
  readonly base: ReleaseRecord;
}

export interface RulesetState {
  readonly tag: string;
  readonly message: string;
  /** Path → text, sorted by path. */
  readonly files: ReadonlyMap<string, string>;
}

const SLOT = /^[a-z0-9][a-z0-9-]*$/;
/** Release asset names: what `sha256sum -c` and a GitHub release accept without quoting. */
const ASSET = /^[A-Za-z0-9._-]+$/;
const json = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

/** The `ruleset-state` commit for a published ruleset release. */
export function rulesetState(i: StateInputs): RulesetState {
  const bad = [...i.ledgers.keys()].find((id) => !SLOT.test(id));
  if (bad !== undefined) throw new Error(`not a ruleset id: ${bad}`);
  const release = { record: i.candidate, repackedFrom: { version: i.base.version, zipSha256: i.base.zipSha256 } };
  const files = new Map<string, string>([
    ...[...i.ledgers].map(([id, t]): [string, string] => [`ledger/${id}.json`, t]),
    ['lists.lock.json', i.lock], ['ruleset-counts.json', i.counts], ['release.json', json(release)],
  ]);
  return {
    tag: `rules/${i.candidate.version}`,
    message: `rules ${i.candidate.version} (repacked from ${i.base.version})\n\nzip sha256 ${i.candidate.zipSha256}\n`,
    files: new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/** `SHA256SUMS` text for release assets (name → bytes), sorted by name. */
export function checksums(assets: ReadonlyMap<string, Uint8Array>): string {
  const names = [...assets.keys()].sort();
  const bad = names.find((n) => !ASSET.test(n));
  if (bad !== undefined) throw new Error(`asset name needs quoting: ${bad}`);
  return names.map((n) => `${sha256Hex(assets.get(n) ?? new Uint8Array())}  ${n}\n`).join('');
}

/** A compiler id-map file name (`dist/compiler/debug/idmap/<rulesetId>.json`). */
const IDMAP_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.json$/;

/**
 * Release assets `idmap-<rulesetId>.json` from the compiler's id maps (filter-pipeline notes §10, P2-16): the
 * id-map bot downloads them from the release of the reported version. Other names are ignored.
 */
export function idmapAssets(files: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, Uint8Array> {
  return new Map([...files].flatMap(([name, bytes]) => {
    const id = IDMAP_FILE.exec(name)?.[1];
    return id === undefined ? [] : [[`idmap-${id}.json`, bytes] as const];
  }).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const TAG = /^(?:refs\/tags\/)?v(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;

/** MAJOR.MINOR of a full-release tag `v<MAJOR>.<MINOR>` (tooling notes §7). */
export function codeLineOfTag(tag: string): { readonly major: number; readonly minor: number } {
  const m = TAG.exec(tag);
  if (m === null) throw new Error(`not a full-release tag v<MAJOR>.<MINOR>: ${tag}`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}
