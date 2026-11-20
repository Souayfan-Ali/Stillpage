/**
 * Comparing build trees byte for byte (P2-48, tooling notes §8): every file of a tree hashed by relative
 * path — text and binary alike (the surrogates are binary, D-34) — the differences between two
 * trees, and the published tree digest: SHA-256 of `sha256sum`-style lines, sorted by path, so anyone
 * can recompute it with `find … | sort | xargs sha256sum`. Also the release-safety scan: the
 * production build must not carry the pop-up guard's log-only path (bench/shadow/logContract.ts).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LOG_ATTRIBUTE, LOG_ONLY_DEFINE, LOG_ONLY_ENV } from '../../bench/shadow/logContract.js';

/** Relative path (always `/`) → SHA-256 hex, sorted by path (code-unit order, like `LC_ALL=C sort`). */
export async function hashTree(root: string): Promise<ReadonlyMap<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/'));
  const sorted = [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hashed = await Promise.all(sorted.map(async (rel) => [rel, createHash('sha256').update(await readFile(path.join(root, rel))).digest('hex')] as const));
  return new Map(hashed);
}

export interface TreeDiff {
  readonly differ: readonly string[];
  readonly onlyA: readonly string[];
  readonly onlyB: readonly string[];
}

export function diffTrees(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): TreeDiff {
  return {
    differ: [...a].filter(([p, h]) => b.has(p) && b.get(p) !== h).map(([p]) => p),
    onlyA: [...a.keys()].filter((p) => !b.has(p)),
    onlyB: [...b.keys()].filter((p) => !a.has(p)),
  };
}

/** The manifest (`<sha256>  <path>` per line) and its own SHA-256: the published unpacked-tree hash. */
export function treeDigest(hashes: ReadonlyMap<string, string>): { manifest: string; sha256: string } {
  const manifest = [...hashes].map(([p, h]) => `${h}  ${p}\n`).join('');
  return { manifest, sha256: createHash('sha256').update(manifest).digest('hex') };
}

const TEXT = /\.(?:js|mjs|html|json|css|txt)$/;
const MARKERS = [LOG_ONLY_ENV, LOG_ONLY_DEFINE, LOG_ATTRIBUTE];

/** `<file>: <marker>` for every text file of `root` that names a log-only marker. */
export async function forbiddenMarkers(root: string): Promise<readonly string[]> {
  const files = [...(await hashTree(root)).keys()].filter((f) => TEXT.test(f));
  const found = await Promise.all(
    files.map(async (f) => {
      const text = await readFile(path.join(root, f), 'utf8');
      return MARKERS.filter((m) => text.includes(m)).map((m) => `${f}: ${m}`);
    }),
  );
  return found.flat();
}
