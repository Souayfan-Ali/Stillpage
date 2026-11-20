/** File I/O of the build CLI: ledgers, counts, regex cache and output trees. */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJsonWith } from '../config/load.js';
import { CountsFileSchema, type CountsFile } from '../postpass/budgets.js';
import { parseLedger, serialiseLedger, type Ledger } from '../postpass/ledger.js';
import { emptyRegexCache, RegexCacheSchema, type RegexCache } from '../validate/regex.js';

const isMissing = (e: unknown): boolean => e instanceof Error && 'code' in e && e.code === 'ENOENT';

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
}

/**
 * The rulesets of the previous build in `dir`, by id (for the growth and diff checks). A missing `dir`
 * is a first build; any other read error is thrown, never taken for one (P2-44).
 */
export async function readPreviousRulesets(dir: string): Promise<ReadonlyMap<string, string>> {
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if (isMissing(e)) return new Map();
    throw e;
  }
  const rulesets = names.filter((n) => n.endsWith('.json'));
  return new Map(await Promise.all(rulesets.map(async (n): Promise<[string, string]> => [n.slice(0, -5), await readFile(path.join(dir, n), 'utf8')])));
}

/** Ledgers of `slots` from `dir`; a slot without a file starts empty (the caller does that). */
export async function readLedgers(dir: string, slots: readonly string[]): Promise<ReadonlyMap<string, Ledger>> {
  const found = await Promise.all(slots.map(async (id): Promise<[string, Ledger] | undefined> => {
    const file = path.join(dir, `${id}.json`);
    const text = await readOptional(file);
    return text === undefined ? undefined : [id, parseLedger(text, file)];
  }));
  return new Map(found.filter((x): x is [string, Ledger] => x !== undefined));
}

/** Writes every ledger that has entries (ledgers only grow, so none is ever deleted). */
export async function writeLedgers(dir: string, ledgers: ReadonlyMap<string, Ledger>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [id, l] of ledgers) if (Object.keys(l.entries).length > 0) await writeFile(path.join(dir, `${id}.json`), serialiseLedger(l), 'utf8');
}

export async function readCounts(file: string): Promise<CountsFile | undefined> {
  const text = await readOptional(file);
  return text === undefined ? undefined : parseJsonWith(CountsFileSchema, text, file);
}

/** The regex cache, or an empty one (for `chromium`) when the file does not exist. */
export async function readRegexCache(file: string, chromium: string): Promise<RegexCache> {
  const text = await readOptional(file);
  return text === undefined ? emptyRegexCache(chromium) : parseJsonWith(RegexCacheSchema, text, file);
}

/** Writes `file` through a sibling temporary name and a rename: the path never holds a partial file. */
async function writeAtomic(file: string, body: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, file);
}

/** Writes `files` (relative path → text or bytes) under `root`, each file atomically. */
export async function writeTree(root: string, files: ReadonlyMap<string, string | Uint8Array>): Promise<void> {
  for (const [rel, body] of files) await writeAtomic(path.join(root, rel), body);
}

/**
 * Replaces the content of `root` (P2-48, D-34): every file is first written to a staging directory
 * beside `root` (same filesystem, outside what WXT packages); only when all of it is written is each
 * of `replaceDirs` moved in whole (the old one removed, so no stale shard ships) and every other file
 * renamed over its old copy. A failure while staging leaves `root` exactly as it was. Each move is a
 * rename, so no path ever holds a partially written file; files outside `replaceDirs` that `files`
 * does not name are kept. If a move itself fails, the replaced directories are left in
 * `.<root>.<pid>.retired` beside `root` (never inside it) and the error is thrown.
 */
export async function replaceTree(root: string, files: ReadonlyMap<string, string | Uint8Array>, replaceDirs: readonly string[]): Promise<void> {
  const parent = path.dirname(root);
  const tag = `${path.basename(root)}.${String(process.pid)}`;
  const staging = path.join(parent, `.${tag}.staging`);
  const retired = path.join(parent, `.${tag}.retired`);
  await rm(staging, { recursive: true, force: true });
  try {
    await writeTree(staging, files);
    await mkdir(retired, { recursive: true });
    await mkdir(root, { recursive: true });
    for (const dir of replaceDirs) {
      if (existsSync(path.join(root, dir))) await rename(path.join(root, dir), path.join(retired, dir));
      if (existsSync(path.join(staging, dir))) await rename(path.join(staging, dir), path.join(root, dir));
    }
    const rest = [...files.keys()].filter((rel) => !replaceDirs.includes(rel.split('/')[0] ?? ''));
    for (const rel of rest) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await rename(path.join(staging, rel), path.join(root, rel));
    }
    // Only after a full swap: if a move failed, the old directories stay beside `root` for recovery.
    await rm(retired, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function writeText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}
