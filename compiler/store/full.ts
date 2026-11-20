/**
 * Full release through standard review (update-strategy notes §4, P2-06): upload a draft, then — after a human approved
 * it in the protected environment — submit it for review with staged (deferred) publishing. Two separate
 * steps so the approval sits between them. Never cancels anything: a full release that goes wrong needs a human.
 */
import { compareVersions, decodeVersion } from '../../src/core/version.js';
import { zipManifestVersion } from '../release/zipVersion.js';
import { hasPendingSubmission, type ItemStatus, type StoreClient } from './client.js';
import type { ReleaseDeps } from './release.js';

type FullStoreClient = Pick<StoreClient, 'status' | 'upload' | 'publishWithReview'>;

export interface FullDeps extends Omit<ReleaseDeps, 'client'> {
  readonly client: FullStoreClient;
}

export type FullReleaseResult =
  | { readonly kind: 'uploaded' | 'submitted'; readonly version: string }
  | { readonly kind: 'refused' | 'failed'; readonly reason: string };

const MINUTE_MS = 60_000;
const UPLOAD_POLL_MS = MINUTE_MS / 2;
const UPLOAD_TIMEOUT_MS = 10 * MINUTE_MS;

/** A full release raises MAJOR.MINOR above the live code line (update-strategy notes §7). */
function lineProblem(candidate: string, live: string | undefined): string | undefined {
  const v = decodeVersion(candidate);
  if (v === undefined) return `${candidate} is outside the version scheme`;
  if (live === undefined) return undefined;
  const [major = 0, minor = 0] = live.split('.').map(Number);
  if (v.major < major || (v.major === major && v.minor <= minor)) return `${candidate} does not raise the code line of the live ${live}`;
  return compareVersions(candidate, live) > 0 ? undefined : `${candidate} is not later than the live ${live}`;
}

const blocked = (s: ItemStatus): string | undefined =>
  (hasPendingSubmission(s) ? `a submission is pending (${s.submitted?.version ?? '?'})` : s.takenDown ? 'item is taken down' : undefined);

async function uploadAndWait(deps: FullDeps, zip: Uint8Array, version: string): Promise<string | undefined> {
  const up = await deps.client.upload(zip);
  let state = up.state;
  const start = deps.now();
  while (state === 'IN_PROGRESS' && deps.now() - start < UPLOAD_TIMEOUT_MS) {
    await deps.sleep(UPLOAD_POLL_MS);
    state = (await deps.client.status()).uploadState ?? 'IN_PROGRESS';
  }
  if (state !== 'SUCCEEDED') return `upload ended ${state}`;
  return up.version === version ? undefined : `store read version ${up.version ?? 'none'}, expected ${version}`;
}

async function precheck(deps: FullDeps, version: string): Promise<string | undefined> {
  const s = await deps.client.status();
  return blocked(s) ?? lineProblem(version, s.publishedVersion);
}

/** Uploads `zip` as a draft for review by a human; refuses while anything is pending or when the version is wrong. */
export async function uploadFullRelease(deps: FullDeps, zip: Uint8Array): Promise<FullReleaseResult> {
  const version = zipManifestVersion(zip);
  const problem = await precheck(deps, version);
  if (problem !== undefined) return { kind: 'refused', reason: problem };
  const failure = await uploadAndWait(deps, zip, version);
  if (failure !== undefined) return { kind: 'failed', reason: failure };
  deps.log(`draft ${version} uploaded; waiting for approval`);
  return { kind: 'uploaded', version };
}

/**
 * After approval: upload the approved bytes again (the draft may have been replaced while waiting), check the
 * store read the approved version, then submit for standard review with staged publishing, and check again.
 */
export async function submitFullRelease(deps: FullDeps, zip: Uint8Array, approved: string): Promise<FullReleaseResult> {
  const version = zipManifestVersion(zip);
  if (version !== approved) return { kind: 'refused', reason: `the zip is ${version}, the approval is for ${approved}` };
  const problem = await precheck(deps, version);
  if (problem !== undefined) return { kind: 'refused', reason: problem };
  const failure = await uploadAndWait(deps, zip, version);
  if (failure !== undefined) return { kind: 'failed', reason: failure };
  await deps.client.publishWithReview();
  const after = await deps.client.status();
  if (after.submitted?.version !== version) {
    return { kind: 'failed', reason: `the store's submission is ${after.submitted?.version ?? 'none'}, not the approved ${version}: manual action required` };
  }
  return { kind: 'submitted', version };
}
