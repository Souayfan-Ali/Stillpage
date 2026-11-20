/**
 * Node side of the vendored uBO files: `vendor/resources/<upstream path>` (git-ignored), a uBO
 * checkout or `raw.githubusercontent.com` at the locked commit as the source, and a hash-checked
 * reader for the build. Build-time only; nothing here ships.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseJsonWith } from '../config/load.js';
import { checkVendored, VendorLockSchema, type VendorLock } from './lock.js';
import type { VendorPorts } from './sync.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const VENDOR_LOCK_FILE = path.join(ROOT, 'vendor/vendor.lock.json');
export const VENDOR_DIR = path.join(ROOT, 'vendor/resources');
const TIMEOUT_MS = 60_000;
const run = promisify(execFile);

const isMissing = (e: unknown): boolean => e instanceof Error && 'code' in e && e.code === 'ENOENT';

/** Resolves `file` under `root`; refuses anything that would leave it. */
function inside(root: string, file: string): string {
  const full = path.resolve(root, file);
  if (!full.startsWith(`${root}${path.sep}`)) throw new Error(`vendor: path "${file}" leaves ${root}`);
  return full;
}

export async function loadVendorLock(file = VENDOR_LOCK_FILE): Promise<VendorLock> {
  return parseJsonWith(VendorLockSchema, await readFile(file, 'utf8'), file);
}

/** Source = a local uBO checkout, which must be at the requested commit. */
export function checkoutSource(dir: string): VendorPorts['readSource'] {
  let head: Promise<string> | undefined;
  return async (commit, file) => {
    head ??= Promise.all([run('git', ['-C', dir, 'rev-parse', 'HEAD']), run('git', ['-C', dir, 'status', '--porcelain'])])
      .then(([h, s]) => (s.stdout.trim() === '' ? h.stdout.trim() : 'dirty'));
    const at = await head;
    if (at === 'dirty') throw new Error(`vendor: checkout ${dir} has local changes; the lock must describe the commit`);
    if (at !== commit) throw new Error(`vendor: checkout ${dir} is at ${at}, the lock wants ${commit}`);
    return readFile(inside(path.resolve(dir), file));
  };
}

/** Source = GitHub's raw file host at the commit (the hash check makes the transport untrusted). */
export function networkSource(repo: string): VendorPorts['readSource'] {
  return async (commit, file) => {
    const url = `https://raw.githubusercontent.com/${repo}/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${String(res.status)}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

export function vendorPorts(readSource: VendorPorts['readSource'], dir = VENDOR_DIR): VendorPorts {
  return {
    readLocal: async (file) => {
      try {
        return await readFile(inside(dir, file));
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },
    writeLocal: async (file, bytes) => {
      const full = inside(dir, file);
      await mkdir(path.dirname(full), { recursive: true });
      const tmp = `${full}.${String(process.pid)}.tmp`;
      await writeFile(tmp, bytes, { flag: 'wx' });
      await rename(tmp, full);
    },
    readSource,
  };
}

/** A reader for the build: the locked bytes of a vendored file, or a thrown error. */
export function vendorReader(lock: VendorLock, dir = VENDOR_DIR): (file: string) => Promise<Buffer> {
  return async (file) => {
    const bytes = await readFile(inside(dir, file)).catch((e: unknown) => {
      throw new Error(`vendor: cannot read "${file}" (run npm run vendor:fetch)`, { cause: e });
    });
    checkVendored(lock, file, bytes);
    return bytes;
  };
}
