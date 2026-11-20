/**
 * Ruleset candidate check of the publish job (D-58, finding D2 of P2-43). The `candidate` job runs the full
 * eligibility gate, but it also runs fetched lists, Playwright and the whole npm tree, so its zip and verdict
 * are untrusted in the one job that holds the store key. This check recomputes, from the bytes alone, what an
 * attacker could exploit (CONTRIBUTING.md "repack, don't rebuild"; update-strategy notes §3.3 E1–E6):
 * - the base is the expected published zip (E1); the candidate is in the repack's deterministic zip layout;
 * - same file list (E2); every changed file is a declared non-`-x` `rulesets/*.json` (E3, E5);
 * - `manifest.json` is the base's bytes with only the version value replaced, by a later version on the same
 *   code line (E4);
 * - every rule of every changed safe ruleset is strictly shaped and skip-review safe, names a site, and the
 *   ruleset stays within the growth guard (E6, E10; `rules.ts`).
 * E7/E8 (quality, open-pr), E9 (Chromium) stay in `candidate`; E11 is re-read from the store by
 * `publish-ruleset`. The check can only narrow `publish` to `abort`, never widen.
 *
 * Dependency-free (D-58b): Node built-ins, `rules.ts`, `../../release/zip.ts` and `src/core/version.ts` only, so it runs
 * with plain `node` before `npm ci`. Data guards are hand-written for that reason (no Zod).
 */
import { createHash } from 'node:crypto';
import { compareVersions, decodeVersion } from '../../../src/core/version.ts';
import { readZip, writeZip } from '../../release/zip.ts';
import { rulesetProblems } from './rules.ts';

const MANIFEST_PATH = 'manifest.json';
const UNSAFE_SUFFIX = '-x';
const RULESET_PATH = /^rulesets\/[A-Za-z0-9._-]+\.json$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION_KEY = /("version"\s*:\s*")([^"\\]*)(")/g;

export interface CandidateCheckInput {
  /** The published zip (live: from `ruleset-state`; dry run: the stand-in from the artefact). */
  readonly base: Uint8Array;
  readonly candidate: Uint8Array;
  /** SHA-256 the base must have (live: `ruleset-state`'s record). */
  readonly expectedBaseSha256: string;
}

export interface CandidateVerdict {
  readonly outcome: 'publish' | 'abort';
  readonly candidateSha256: string;
  readonly candidateVersion?: string;
  readonly baseVersion?: string;
  readonly problems: readonly string[];
}

interface Manifest {
  readonly version: string;
  readonly text: string;
  readonly hasVersionName: boolean;
  readonly resources: readonly { readonly id: string; readonly path: string }[];
}

interface Unpacked { readonly files: ReadonlyMap<string, Uint8Array>; readonly manifest: Manifest }

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strictText = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function resourcesOf(json: Record<string, unknown>): Manifest['resources'] {
  const dnr = json['declarative_net_request'];
  if (dnr === undefined) return [];
  const list = isRecord(dnr) ? dnr['rule_resources'] : undefined;
  if (!Array.isArray(list)) throw new Error('manifest.json declarative_net_request has no rule_resources list');
  return list.map((r: unknown) => {
    if (!isRecord(r) || typeof r['id'] !== 'string' || typeof r['path'] !== 'string' || r['id'] === '' || r['path'] === '') {
      throw new Error('manifest.json has a rule_resources entry without an id and a path');
    }
    return { id: r['id'], path: r['path'].replace(/^\/+/, '') };
  });
}

function manifestOf(files: ReadonlyMap<string, Uint8Array>): Manifest {
  const entry = files.get(MANIFEST_PATH);
  if (entry === undefined) throw new Error('zip has no manifest.json');
  const text = strictText(entry);
  const json: unknown = JSON.parse(text);
  if (!isRecord(json) || typeof json['version'] !== 'string') throw new Error('manifest.json has no version string');
  return { version: json['version'], text, hasVersionName: Object.hasOwn(json, 'version_name'), resources: resourcesOf(json) };
}

function unpack(bytes: Uint8Array): Unpacked {
  const files = new Map(readZip(bytes).map((e) => [e.path, e.data]));
  return { files, manifest: manifestOf(files) };
}

/** The candidate must be exactly what `writeZip` makes of its own entries: no prepended, trailing or extra bytes. */
function layoutProblems(bytes: Uint8Array): readonly string[] {
  const rewritten = writeZip(readZip(bytes));
  return Buffer.from(rewritten).equals(Buffer.from(bytes)) ? [] : ["candidate is not a zip in the repack's deterministic layout"];
}

function fileListProblems(base: Unpacked, candidate: Unpacked): readonly string[] {
  const added = [...candidate.files.keys()].filter((p) => !base.files.has(p)).map((p) => `added: ${p}`);
  const removed = [...base.files.keys()].filter((p) => !candidate.files.has(p)).map((p) => `removed: ${p}`);
  return [...added, ...removed];
}

function versionProblems(base: string, next: string): readonly string[] {
  const v = decodeVersion(next);
  if (v === undefined) return [`candidate version ${next} is outside the scheme`];
  const [major = 0, minor = 0] = base.split('.').map(Number);
  if (v.major !== major || v.minor !== minor) return [`candidate ${next} changes the code line of ${base}`];
  return compareVersions(next, base) > 0 ? [] : [`candidate ${next} is not later than ${base}`];
}

function manifestProblems(base: Manifest, candidate: Manifest): readonly string[] {
  const hits = [...base.text.matchAll(VERSION_KEY)];
  if (base.hasVersionName || hits.length !== 1) return ['base manifest has version_name or not exactly one "version" key'];
  const expected = base.text.replace(VERSION_KEY, (_m, open: string, _v: string, close: string) => `${open}${candidate.version}${close}`);
  if (expected !== candidate.text) return ['manifest.json differs from the base in more than the "version" value'];
  return versionProblems(base.version, candidate.version);
}

function changedFileProblems(base: Unpacked, candidate: Unpacked): readonly string[] {
  const declared = new Map(base.manifest.resources.map((r) => [r.path, r.id]));
  if (declared.size !== base.manifest.resources.length) return ['base manifest declares a rule_resources path twice'];
  const changed = [...base.files].filter(([p, data]) => {
    const next = candidate.files.get(p);
    return p !== MANIFEST_PATH && next !== undefined && !Buffer.from(next).equals(Buffer.from(data));
  }).map(([p]) => p);
  return changed.flatMap((p) => {
    const id = declared.get(p);
    if (id === undefined || !RULESET_PATH.test(p)) return [`changed outside the safe rulesets: ${p}`];
    if (id.endsWith(UNSAFE_SUFFIX)) return [`-x ruleset changed: ${p}`];
    return rulesetProblems(p, base.files.get(p) ?? new Uint8Array(), candidate.files.get(p) ?? new Uint8Array());
  });
}

function read(bytes: Uint8Array, name: string): Unpacked | string {
  try {
    return unpack(bytes);
  } catch (e) {
    return `unreadable ${name}: ${message(e)}`;
  }
}

function baseProblems(input: CandidateCheckInput): readonly string[] {
  if (!SHA256.test(input.expectedBaseSha256)) return ['expected base SHA-256 is not 64 lower-case hex digits'];
  const actual = sha256Hex(input.base);
  return actual === input.expectedBaseSha256 ? [] : [`base zip SHA-256 ${actual} is not the expected ${input.expectedBaseSha256}`];
}

/** Recomputes the publish verdict from the bytes. Never throws on bad input: anything unreadable is an abort. */
export function checkRulesetCandidate(input: CandidateCheckInput): CandidateVerdict {
  const candidateSha256 = sha256Hex(input.candidate);
  const abort = (problems: readonly string[]): CandidateVerdict => ({ outcome: 'abort', candidateSha256, problems });
  const shaProblems = baseProblems(input);
  if (shaProblems.length > 0) return abort(shaProblems);
  const base = read(input.base, 'base');
  const candidate = read(input.candidate, 'candidate');
  if (typeof base === 'string' || typeof candidate === 'string') return abort([base, candidate].filter((x) => typeof x === 'string'));
  const problems = [
    ...layoutProblems(input.candidate), ...fileListProblems(base, candidate),
    ...manifestProblems(base.manifest, candidate.manifest), ...changedFileProblems(base, candidate),
  ];
  const named = { candidateSha256, candidateVersion: candidate.manifest.version, baseVersion: base.manifest.version };
  return { outcome: problems.length === 0 ? 'publish' : 'abort', ...named, problems };
}
