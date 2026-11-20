/**
 * `npm run lists:fetch [-- --refresh] [-- --ref <source>=<commit>] [-- --offline] [-- --drop-pending]`
 *
 * Default: re-uses the locked commits and cached bytes, downloads only what is missing. Locked bytes are
 * read from `.cache/lists/`, then from the tracked `lists/snapshots/` (D-123).
 * `--refresh`: moves every source to its branch head and re-downloads unversioned lists.
 * `--offline`: no network, read-only; checks that every locked list is in a store with matching bytes.
 * `--drop-pending`: leaves out the lists of owner-pending packs (D-124), as `lists:build --drop-pending`
 * does; their lock entries are kept unchanged.
 *
 * After writing the lock (never with `--offline`), `lists/snapshots/` is made to hold exactly the bytes of
 * the lock's unversioned, cleared lists (computed from the full config): missing files are written from
 * the cache, stale ones removed. Only this command writes that folder.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { withoutPendingPacks } from '../config/channel.js';
import { loadListsConfig, loadLock } from '../config/load.js';
import { COMMIT_PATTERN, type ListsConfig } from '../config/schema.js';
import { fetchLists, loadLockedLists, type FetchPorts } from './fetch.js';
import { serialiseLock, withCarriedEntries, type LockFile } from './lock.js';
import { nodePorts, presentSnapshots, syncSnapshots } from './node-ports.js';
import { snapshotHashes, snapshotPlan } from './snapshots.js';
import { errorText } from '../cli/errors.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const CONFIG_FILE = path.join(ROOT, 'lists/lists.config.json');
export const LOCK_FILE = path.join(ROOT, 'lists/lists.lock.json');
export const CACHE_DIR = path.join(ROOT, '.cache/lists');
export const SNAPSHOT_DIR = path.join(ROOT, 'lists/snapshots');

function parseRefs(values: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    values.map((v) => {
      const i = v.indexOf('=');
      const [source, commit] = i === -1 ? ['', ''] : [v.slice(0, i), v.slice(i + 1)];
      if (!source || !COMMIT_PATTERN.test(commit)) throw new Error(`--ref expects <source>=<40-hex commit>, got "${v}"`);
      return [source, commit];
    }),
  );
}

/** Makes `lists/snapshots/` match the cleared snapshot entries of `lock` (always from the full config). */
async function syncSnapshotDir(full: ListsConfig, lock: LockFile, readCache: FetchPorts['readCache']): Promise<void> {
  const wanted = snapshotHashes(full, lock);
  const plan = snapshotPlan(wanted, await presentSnapshots(SNAPSHOT_DIR));
  await syncSnapshots(SNAPSHOT_DIR, plan, readCache);
  const kept = wanted.length - plan.write.length;
  process.stdout.write(`snapshots: ${String(kept)} kept, ${String(plan.write.length)} written, ${String(plan.remove.length)} removed\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { refresh: { type: 'boolean', default: false }, offline: { type: 'boolean', default: false }, ref: { type: 'string', multiple: true, default: [] },
      'drop-pending': { type: 'boolean', default: false } },
  });
  const full = await loadListsConfig(CONFIG_FILE);
  const config = values['drop-pending'] ? withoutPendingPacks(full) : full;
  const lock = await loadLock(LOCK_FILE);
  const ports = nodePorts(CACHE_DIR, [SNAPSHOT_DIR]);
  if (values.offline) {
    const texts = await loadLockedLists(config, lock, ports.readCache);
    process.stdout.write(`offline: ${String(texts.size)} lists present and matching the lock\n`);
    return;
  }
  const refs = parseRefs(values.ref);
  const unknown = Object.keys(refs).filter((id) => !(id in config.sources));
  if (unknown.length > 0) throw new Error(`--ref names unknown source(s): ${unknown.join(', ')}`);
  const result = await fetchLists(config, lock, ports, { refresh: values.refresh, refs });
  const kept = new Set(config.lists.map((l) => l.id));
  const newLock = withCarriedEntries(result.lock, lock, full.lists.map((l) => l.id).filter((id) => !kept.has(id)));
  await writeFile(LOCK_FILE, serialiseLock(newLock), 'utf8');
  process.stdout.write(`lists: ${String(config.lists.length)}, downloaded: ${result.downloaded.join(', ') || 'none'}, changed: ${result.changed.join(', ') || 'none'}\n`);
  await syncSnapshotDir(full, newLock, ports.readCache);
}

main().catch((e: unknown) => {
  process.stderr.write(`lists:fetch failed: ${errorText(e)}\n`);
  process.exitCode = 1;
});
