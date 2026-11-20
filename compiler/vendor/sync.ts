/**
 * Fetching the vendored uBO files (ADR-005): every locked file is read from the local copy, else
 * from the source (a uBO checkout at the locked commit, or the network at that commit), and kept only
 * when its SHA-256 matches the lock. `pin` re-hashes a checkout to bump the lock (a reviewed change).
 * All I/O goes through `VendorPorts`.
 */
import { checkVendored, sha256Bytes, type VendorLock } from './lock.js';

export interface VendorPorts {
  /** Bytes of a vendored file in `vendor/resources/`, or null when absent. */
  readonly readLocal: (file: string) => Promise<Uint8Array | null>;
  readonly writeLocal: (file: string, bytes: Uint8Array) => Promise<void>;
  /** Bytes of `file` at `commit` from the source (checkout or network). */
  readonly readSource: (commit: string, file: string) => Promise<Uint8Array>;
}

export interface SyncResult {
  readonly fetched: readonly string[];
  readonly present: readonly string[];
}

/** Makes `vendor/resources/` match the lock. Throws on the first hash mismatch from the source. */
export async function syncVendor(lock: VendorLock, ports: VendorPorts): Promise<SyncResult> {
  const fetched: string[] = [];
  const present: string[] = [];
  for (const file of Object.keys(lock.files).sort()) {
    const local = await ports.readLocal(file);
    if (local !== null && sha256Bytes(local) === lock.files[file]) {
      present.push(file);
      continue;
    }
    const bytes = await ports.readSource(lock.commit, file);
    checkVendored(lock, file, bytes);
    await ports.writeLocal(file, bytes);
    fetched.push(file);
  }
  return { fetched, present };
}

/** A new lock for `commit` with the current hashes of `files` from the source. */
export async function pinVendor(base: Pick<VendorLock, 'repo'>, commit: string, files: readonly string[], ports: VendorPorts): Promise<VendorLock> {
  const entries = await Promise.all([...new Set(files)].sort().map(async (f) => [f, sha256Bytes(await ports.readSource(commit, f))] as const));
  return { schema: 1, repo: base.repo, commit, files: Object.fromEntries(entries) };
}
