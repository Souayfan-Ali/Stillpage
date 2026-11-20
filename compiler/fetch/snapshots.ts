/**
 * `lists/snapshots/` (D-123, D-124): the locked bytes of every unversioned list whose licence is cleared,
 * one `<sha256>.txt` per list, so a fresh clone builds the exact lock without upstream's old bytes.
 * Pure: what belongs there and what to change; `node-ports.ts` does the file I/O.
 */
import type { ListsConfig } from '../config/schema.js';
import type { LockFile } from './lock.js';

/** sha256 of every list whose bytes belong in `lists/snapshots/`: lock ref `snapshot` and licence `cleared`. Sorted, unique. */
export function snapshotHashes(config: ListsConfig, lock: LockFile): readonly string[] {
  const hashes = config.lists
    .filter((l) => l.licenceState === 'cleared')
    .map((l) => lock.lists[l.id])
    .filter((e) => e?.ref.kind === 'snapshot')
    .map((e) => e?.sha256 ?? '');
  return [...new Set(hashes)].sort();
}

export interface SnapshotPlan {
  readonly write: readonly string[];
  readonly remove: readonly string[];
}

/** What to add and what to delete so the directory holds exactly `wanted`. `present` = hashes of its `<sha256>.txt` files. */
export function snapshotPlan(wanted: readonly string[], present: readonly string[]): SnapshotPlan {
  const have = new Set(present);
  const want = new Set(wanted);
  return {
    write: [...want].filter((h) => !have.has(h)).sort(),
    remove: [...have].filter((h) => !want.has(h)).sort(),
  };
}
