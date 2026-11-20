/**
 * TEST-ONLY guard for the packed-install harness (`packed.ts`, D-33). That harness writes a Chromium
 * Preferences entry with a forged tracked-preference MAC, which is acceptable only in a throwaway Playwright
 * profile. Every profile it may touch must have been created by `createThrowawayProfile()` in this process:
 * a fresh `mkdtemp` directory directly under the OS temp dir, not a symlink, holding a marker file with a random
 * token that only this process knows. Real user profiles can never pass.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const THROWAWAY_MARKER = '.glassmere-throwaway-profile';
const PREFIX = 'glassmere-packed-profile-';
const TOKEN_BYTES = 16;
/** Real path → token, for the profiles this process created. */
const created = new Map<string, string>();

/** A fresh, empty temp profile directory, registered as throwaway for this process. */
export async function createThrowawayProfile(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), PREFIX)));
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  await writeFile(path.join(dir, THROWAWAY_MARKER), token);
  created.set(dir, token);
  return dir;
}

/** Throws unless `dir` is a profile `createThrowawayProfile()` made in this process and nobody replaced. */
export async function assertThrowawayProfile(dir: string): Promise<void> {
  const refuse = (why: string): never => { throw new Error(`not a throwaway profile (${why}): ${dir}`); };
  const stat = await lstat(dir).catch(() => refuse('missing'));
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse('not a plain directory');
  const real = await realpath(dir);
  const temp = await realpath(tmpdir());
  if (path.dirname(real) !== temp || !path.basename(real).startsWith(PREFIX)) refuse('outside the temp dir');
  const token = created.get(real) ?? refuse('not created by this test run');
  const marker = await readFile(path.join(real, THROWAWAY_MARKER), 'utf8').catch(() => '');
  if (marker !== token) throw new Error(`not a throwaway profile (marker changed): ${dir}`);
}

/** Removes every throwaway profile this process created. */
export async function removeThrowawayProfiles(): Promise<void> {
  await Promise.all([...created.keys()].map((d) => rm(d, { recursive: true, force: true })));
  created.clear();
}
