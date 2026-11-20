/**
 * Stage 1 (filter-pipeline notes §2): fetch every configured list into a content-addressed cache and write the
 * lock. All I/O goes through `FetchPorts`, so the logic is testable without a network.
 *
 * - A git source is fetched at one commit for all its lists: the override, else the locked commit,
 *   else (or with `refresh`) the branch head.
 * - A list whose locked bytes are already in the cache is not downloaded again (offline rebuild).
 * - `fetchedOn` only changes when the bytes change.
 */
import { createHash } from 'node:crypto';
import { isGitList, type ListConfig, type ListsConfig } from '../config/schema.js';
import type { LockEntry, LockFile, UpstreamRef } from './lock.js';
import { LOCK_SCHEMA } from './lock.js';

/** Upper bound for one list file; the largest default list (EasyPrivacy) is ≈ 2 MB. */
const MAX_LIST_BYTES = 32 * 1024 * 1024;

export interface FetchPorts {
  /** GET `url` and return the body as text; throws on any non-2xx status or network error. */
  readonly getText: (url: string) => Promise<string>;
  /** Commit SHA at the head of `branch` in `repo` (`owner/name`). */
  readonly latestCommit: (repo: string, branch: string) => Promise<string>;
  readonly readCache: (sha256: string) => Promise<string | null>;
  readonly writeCache: (sha256: string, text: string) => Promise<void>;
  /** Today's UTC date, `YYYY-MM-DD`. */
  readonly today: () => string;
}

export interface FetchOptions {
  /** Resolve every git source to its branch head and re-download unversioned lists. */
  readonly refresh: boolean;
  /** Source id → commit, overriding the lock and `refresh`. */
  readonly refs: Readonly<Record<string, string>>;
}

export interface FetchResult {
  readonly lock: LockFile;
  /** Ids of lists whose bytes differ from the previous lock (new lists included). */
  readonly changed: readonly string[];
  /** Ids of lists that were downloaded (the rest came from the cache). */
  readonly downloaded: readonly string[];
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const rawGitUrl = (repo: string, commit: string, path: string): string =>
  `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;

function lockedCommit(config: ListsConfig, lock: LockFile, sourceId: string): string | undefined {
  const entry = config.lists
    .filter((l) => isGitList(l) && l.source === sourceId)
    .map((l) => lock.lists[l.id]?.ref)
    .find((ref) => ref?.kind === 'git');
  return entry?.kind === 'git' ? entry.commit : undefined;
}

async function resolveCommits(
  config: ListsConfig,
  lock: LockFile,
  ports: FetchPorts,
  options: FetchOptions,
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    Object.entries(config.sources).map(async ([id, src]): Promise<[string, string]> => {
      const pinned = options.refs[id] ?? (options.refresh ? undefined : lockedCommit(config, lock, id));
      return [id, pinned ?? (await ports.latestCommit(src.repo, src.branch))];
    }),
  );
  return new Map(entries);
}

function target(list: ListConfig, config: ListsConfig, commits: ReadonlyMap<string, string>): { url: string; ref: UpstreamRef } {
  if (!isGitList(list)) return { url: list.url, ref: { kind: 'snapshot' } };
  const repo = config.sources[list.source]?.repo ?? '';
  const commit = commits.get(list.source) ?? '';
  return { url: rawGitUrl(repo, commit, list.path), ref: { kind: 'git', repo, commit } };
}

function checkText(id: string, text: string): void {
  if (text.trim() === '') throw new Error(`list "${id}": empty download`);
  if (Buffer.byteLength(text, 'utf8') > MAX_LIST_BYTES) throw new Error(`list "${id}": larger than ${String(MAX_LIST_BYTES)} bytes`);
}

async function fetchOne(
  list: ListConfig,
  previous: LockEntry | undefined,
  where: { url: string; ref: UpstreamRef },
  ports: FetchPorts,
  refresh: boolean,
): Promise<{ entry: LockEntry; downloaded: boolean }> {
  const mayMove = refresh && where.ref.kind === 'snapshot';
  const reusable = previous?.url === where.url && !mayMove;
  if (reusable) {
    const cached = await ports.readCache(previous.sha256);
    if (cached !== null && sha256Hex(cached) === previous.sha256) return { entry: previous, downloaded: false };
  }
  const text = await ports.getText(where.url);
  checkText(list.id, text);
  const sha256 = sha256Hex(text);
  // Same URL, different bytes: a pinned commit never changes, and a snapshot moves only with --refresh.
  if (reusable && sha256 !== previous.sha256) {
    throw new Error(`list "${list.id}": ${where.url} now has sha256 ${sha256}, the lock pins ${previous.sha256}${where.ref.kind === 'snapshot' ? ' (use --refresh to move a snapshot)' : ''}`);
  }
  await ports.writeCache(sha256, text);
  const fetchedOn = previous?.sha256 === sha256 ? previous.fetchedOn : ports.today();
  const entry: LockEntry = { url: where.url, sha256, bytes: Buffer.byteLength(text, 'utf8'), ref: where.ref, fetchedOn };
  return { entry, downloaded: true };
}

/** Fetches every list of `config`; returns the new lock (the caller writes it). */
export async function fetchLists(
  config: ListsConfig,
  lock: LockFile,
  ports: FetchPorts,
  options: FetchOptions,
): Promise<FetchResult> {
  const commits = await resolveCommits(config, lock, ports, options);
  const results = await Promise.all(
    config.lists.map(async (list) => {
      const r = await fetchOne(list, lock.lists[list.id], target(list, config, commits), ports, options.refresh);
      return { id: list.id, ...r };
    }),
  );
  return {
    lock: { schema: LOCK_SCHEMA, lists: Object.fromEntries(results.map((r) => [r.id, r.entry])) },
    changed: results.filter((r) => lock.lists[r.id]?.sha256 !== r.entry.sha256).map((r) => r.id),
    downloaded: results.filter((r) => r.downloaded).map((r) => r.id),
  };
}

/**
 * Offline rebuild: the text of every configured list from the cache, checked against the lock.
 * Throws when a list is missing from the lock or the cache, or its bytes do not match.
 */
export async function loadLockedLists(
  config: ListsConfig,
  lock: LockFile,
  readCache: FetchPorts['readCache'],
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    config.lists.map(async (list): Promise<[string, string]> => {
      const entry = lock.lists[list.id];
      if (!entry) throw new Error(`list "${list.id}" is not in the lock; run lists:fetch`);
      const text = await readCache(entry.sha256);
      if (text === null) throw new Error(`list "${list.id}" (${entry.sha256}) is not in the cache; run lists:fetch`);
      if (sha256Hex(text) !== entry.sha256) throw new Error(`list "${list.id}": cached bytes do not match the lock`);
      return [list.id, text];
    }),
  );
  return new Map(entries);
}
