/**
 * Real `FetchPorts` for the build machine: HTTPS via `fetch`, the GitHub commits API for branch
 * heads, and content-addressed stores of list bytes (files named `<sha256>.txt`): the git-ignored
 * `.cache/lists/`, read first and the only one written by downloads, then any
 * read-only directory such as the tracked `lists/snapshots/` (D-123), which only `syncSnapshots` writes.
 * Every caller checks the bytes against the lock. Build-time only; nothing here ships in the extension.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { COMMIT_PATTERN } from '../config/schema.js';
import { sha256Hex, type FetchPorts } from './fetch.js';
import type { SnapshotPlan } from './snapshots.js';

const TIMEOUT_MS = 60_000;
const USER_AGENT = 'list-compiler (build tool)';
const CommitSchema = z.object({ sha: z.string().regex(COMMIT_PATTERN) });
/** The only file names a snapshot directory sync reads, writes or removes. */
const SNAPSHOT_FILE = /^([0-9a-f]{64})\.txt$/;

async function get(url: string, accept: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { accept, 'user-agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${String(res.status)}`);
  return res;
}

const isMissing = (e: unknown): boolean => e instanceof Error && 'code' in e && e.code === 'ENOENT';
const fileOf = (dir: string, sha: string): string => path.join(dir, `${sha}.txt`);

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** Writes `<sha>.txt` in `dir` through a temporary name and a rename. */
async function writeStore(dir: string, sha: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = `${fileOf(dir, sha)}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, fileOf(dir, sha));
}

/** The first of `dirs` that holds `<sha>.txt`; a missing file moves on, any other error is thrown. */
async function readFirst(dirs: readonly string[], sha: string): Promise<string | null> {
  for (const dir of dirs) {
    const text = await readOptional(fileOf(dir, sha));
    if (text !== null) return text;
  }
  return null;
}

/** Ports backed by the network and `cacheDir`; reads fall back to each of `readOnlyDirs` in order. */
export function nodePorts(cacheDir: string, readOnlyDirs: readonly string[] = []): FetchPorts {
  return {
    getText: async (url) => (await get(url, 'text/plain, */*')).text(),
    latestCommit: async (repo, branch) => {
      const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`;
      return CommitSchema.parse(await (await get(url, 'application/vnd.github+json')).json()).sha;
    },
    readCache: (sha) => readFirst([cacheDir, ...readOnlyDirs], sha),
    writeCache: (sha, text) => writeStore(cacheDir, sha, text),
    today: () => new Date().toISOString().slice(0, 10),
  };
}

/** Hashes of the `<sha256>.txt` files in `dir` (none when it does not exist). Other names are ignored. */
export async function presentSnapshots(dir: string): Promise<readonly string[]> {
  try {
    return (await readdir(dir)).flatMap((name) => SNAPSHOT_FILE.exec(name)?.[1] ?? []).sort();
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
}

/**
 * Applies `plan` to `dir`: each `write` hash is copied from `readCache` (it must be there and hash to its
 * name), each `remove` file is deleted. Only names `<64 hex>.txt` are touched; `.gitattributes` and any
 * other file are left alone.
 */
export async function syncSnapshots(dir: string, plan: SnapshotPlan, readCache: FetchPorts['readCache']): Promise<void> {
  const names = [...plan.write, ...plan.remove].map((sha) => `${sha}.txt`);
  const bad = names.filter((n) => !SNAPSHOT_FILE.test(n));
  if (bad.length > 0) throw new Error(`snapshots: not a sha256 file name: ${bad.join(', ')}`);
  for (const sha of plan.write) {
    const text = await readCache(sha);
    if (text === null) throw new Error(`snapshots: ${sha} is not in the cache; run lists:fetch on a machine that has it`);
    if (sha256Hex(text) !== sha) throw new Error(`snapshots: cached bytes of ${sha} do not hash to their name`);
    await writeStore(dir, sha, text);
  }
  for (const sha of plan.remove) await rm(fileOf(dir, sha), { force: true });
}
