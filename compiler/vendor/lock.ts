/**
 * `vendor/vendor.lock.json` (ADR-005, tooling notes §1): the uBO commit we vendor from and the SHA-256 of
 * every vendored file. The files themselves live in the git-ignored `vendor/resources/` and are
 * fetched by `npm run vendor:fetch`; the build refuses any file whose bytes differ from the lock.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { COMMIT_PATTERN } from '../config/schema.js';

const VENDOR_LOCK_SCHEMA = 1;
const SHA256 = /^[0-9a-f]{64}$/;
/** Repository-relative path inside uBO: no `..`, no leading `/`. */
const UPSTREAM_PATH = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;

const FileSchema = z.strictObject({
  path: z.string().regex(UPSTREAM_PATH).refine((p) => !p.split('/').includes('..'), 'path has ..'),
  sha256: z.string().regex(SHA256),
});

/** On disk, files are `[{path, sha256}]` (one key per line keeps secret scanners from reading a digest as a key). */
export const VendorLockSchema = z.strictObject({
  schema: z.literal(VENDOR_LOCK_SCHEMA),
  repo: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/),
  commit: z.string().regex(COMMIT_PATTERN),
  files: z.array(FileSchema),
}).transform((l, ctx) => {
  const paths = l.files.map((f) => f.path);
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: 'custom', message: 'duplicate path' });
  return { ...l, files: Object.fromEntries(l.files.map((f) => [f.path, f.sha256])) };
});

export type VendorLock = z.output<typeof VendorLockSchema>;

export const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Sorted, stable serialisation. */
export function serialiseVendorLock(lock: VendorLock): string {
  const files = Object.entries(lock.files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, sha256]) => ({ path, sha256 }));
  return `${JSON.stringify({ ...lock, files }, null, 2)}\n`;
}

/** Throws unless `bytes` are the locked bytes of `file`. */
export function checkVendored(lock: VendorLock, file: string, bytes: Uint8Array): void {
  const want = Object.hasOwn(lock.files, file) ? lock.files[file] : undefined;
  if (want === undefined) throw new Error(`vendor: "${file}" is not in vendor.lock.json`);
  const got = sha256Bytes(bytes);
  if (got !== want) throw new Error(`vendor: "${file}" has SHA-256 ${got}, the lock says ${want} (run npm run vendor:fetch)`);
}
