/**
 * `lists/lists.lock.json` (P1-15, filter-pipeline notes §13): one entry per list with the exact URL fetched, the
 * SHA-256 of the bytes and the upstream ref (a git commit, or "snapshot" for unversioned lists).
 * Written only by the fetch step; never edited by hand (CONTRIBUTING.md).
 */
import { z } from 'zod';
import { COMMIT_PATTERN } from '../config/schema.js';

export const LOCK_SCHEMA = 1;

const SHA256 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const RefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('git'), repo: z.string().min(1), commit: z.string().regex(COMMIT_PATTERN) }),
  z.strictObject({ kind: z.literal('snapshot') }),
]);

const LockEntrySchema = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  sha256: z.string().regex(SHA256),
  bytes: z.number().int().positive(),
  ref: RefSchema,
  /** UTC day on which these exact bytes were first fetched (kept while the hash is unchanged). */
  fetchedOn: z.string().regex(DAY),
});

export const LockFileSchema = z.strictObject({
  schema: z.literal(LOCK_SCHEMA),
  lists: z.record(z.string(), LockEntrySchema),
});

export type LockEntry = z.infer<typeof LockEntrySchema>;
export type LockFile = z.infer<typeof LockFileSchema>;
export type UpstreamRef = LockEntry['ref'];

/** A lock with no entries. */
export const EMPTY_LOCK: LockFile = Object.freeze({ schema: LOCK_SCHEMA, lists: Object.freeze({}) });

/** Serialises a lock with sorted keys and a trailing newline, so equal locks are equal bytes. */
export function serialiseLock(lock: LockFile): string {
  const lists = Object.fromEntries(
    Object.entries(lock.lists)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, e]: [string, LockEntry]) => [id, { url: e.url, sha256: e.sha256, bytes: e.bytes, ref: e.ref, fetchedOn: e.fetchedOn }]),
  );
  return `${JSON.stringify({ schema: lock.schema, lists }, null, 2)}\n`;
}

/**
 * `next` plus the previous entries of the `carried` lists (D-124): a subset fetch (`--drop-pending`) keeps
 * the pins of the lists it left out, byte for byte. A carried id without a previous entry adds nothing.
 */
export function withCarriedEntries(next: LockFile, previous: LockFile, carried: readonly string[]): LockFile {
  const kept = carried.flatMap((id) => {
    const entry = previous.lists[id];
    return entry === undefined || id in next.lists ? [] : [[id, entry] as const];
  });
  return { schema: next.schema, lists: { ...next.lists, ...Object.fromEntries(kept) } };
}
