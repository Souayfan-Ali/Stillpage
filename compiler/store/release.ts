/**
 * Ruleset release through skip review (update-strategy notes §3.4, P2-04): status (E11) → upload → status again (E11) →
 * publish with skip review → poll until live. **Never falls back to standard review**: a submission of ours
 * that is still in review after the grace period, or at the timeout, is cancelled and the run fails with
 * an alert. Only our own submission is ever cancelled (its version must equal the candidate's); after a
 * cancel the state is re-checked, and anything unexpected ends in "manual action required", never a retry.
 */
import { compareVersions, decodeVersion } from '../../src/core/version.ts';
import { zipManifestVersion } from '../release/zipVersion.ts';
import { hasPendingSubmission, StoreHttpError, toStoreState, type ItemStatus, type StoreClient } from './client.ts';

const MINUTE_MS = 60_000;
const POLL_INTERVAL_MS = MINUTE_MS / 2;
const UPLOAD_TIMEOUT_MS = 10 * MINUTE_MS;
/** How long a skip-review submission may sit in PENDING_REVIEW before we call it "sent to review" (UNVERIFIED, S-12). */
export const REVIEW_GRACE_MS = 15 * MINUTE_MS;
/** update-strategy notes §3.4: poll item state until live, timeout 60 min. */
const PUBLISH_TIMEOUT_MS = 60 * MINUTE_MS;

/** What the ruleset path may call: no `publishWithReview`, so it cannot ask for standard review. */
type RulesetStoreClient = Pick<StoreClient, 'status' | 'upload' | 'publishSkipReview' | 'cancelSubmission'>;

export interface ReleaseDeps {
  readonly client: RulesetStoreClient;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
}

export type RulesetReleaseResult =
  | { readonly kind: 'live'; readonly version: string }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string; readonly manualAction: boolean };

export type PollClass = 'live' | 'waiting' | 'cancel' | 'rejected' | 'foreign' | 'timeout';

/** What one status answer means for our candidate, `elapsed` ms after the publish call. */
export function classifyPoll(s: ItemStatus, candidate: string, elapsed: number): PollClass {
  if (s.publishedVersion === candidate) return 'live';
  const sub = s.submitted;
  if (sub !== undefined && sub.version !== candidate && hasPendingSubmission(s)) return 'foreign';
  if (sub?.version === candidate && (sub.state === 'REJECTED' || sub.state === 'CANCELLED')) return 'rejected';
  const ours = sub?.version === candidate && hasPendingSubmission(s);
  if (ours && elapsed > REVIEW_GRACE_MS) return 'cancel';
  if (elapsed > PUBLISH_TIMEOUT_MS) return ours ? 'cancel' : 'timeout';
  return 'waiting';
}

const failed = (reason: string, manualAction: boolean): RulesetReleaseResult => ({ kind: 'failed', reason, manualAction });

/** E11 problems of a status answer (update-strategy notes §3.3). */
function e11(s: ItemStatus): string | undefined {
  const st = toStoreState(s);
  if (!st.published) return 'item is not published';
  if (st.warned) return 'item carries a warning';
  return st.pendingSubmission ? 'a submission is pending' : undefined;
}

async function waitForUpload(deps: ReleaseDeps, first: string): Promise<string> {
  let state = first;
  const start = deps.now();
  while (state === 'IN_PROGRESS' && deps.now() - start < UPLOAD_TIMEOUT_MS) {
    await deps.sleep(POLL_INTERVAL_MS);
    state = (await deps.client.status()).uploadState ?? 'IN_PROGRESS';
  }
  return state;
}

/** Cancels our own pending submission and checks that the item is back where it was. */
async function cancelOurs(deps: ReleaseDeps, base: string, candidate: string, why: string): Promise<RulesetReleaseResult> {
  // Re-read right before cancelling: the call cancels whatever is pending, so it must still be ours.
  const now = await deps.client.status();
  if (now.submitted?.version !== candidate || now.submitted.state !== 'PENDING_REVIEW') {
    return failed(`${why}; the pending submission is no longer ours (${now.submitted?.version ?? 'none'}): manual action required`, true);
  }
  deps.log(`cancelling our submission: ${why}`);
  try {
    await deps.client.cancelSubmission();
  } catch (e) {
    return failed(`${why}; cancel failed (${e instanceof Error ? e.message : String(e)}): manual action required`, true);
  }
  const after = await deps.client.status();
  if (hasPendingSubmission(after) || after.publishedVersion !== base) return failed(`${why}; state after cancel is unexpected: manual action required`, true);
  return failed(`${why}; submission cancelled, ${base} stays live`, false);
}

async function pollUntilLive(deps: ReleaseDeps, candidate: string, base: string): Promise<RulesetReleaseResult> {
  const start = deps.now();
  for (;;) {
    const s = await deps.client.status();
    const c = classifyPoll(s, candidate, deps.now() - start);
    if (c === 'live') return { kind: 'live', version: candidate };
    if (c === 'cancel') return cancelOurs(deps, base, candidate, 'review was not skipped');
    if (c === 'rejected') return failed(`submission ${candidate} was ${s.submitted?.state ?? 'rejected'}`, false);
    if (c === 'foreign') return failed(`another submission (${s.submitted?.version ?? '?'}) is pending: manual action required`, true);
    if (c === 'timeout') return failed(`${candidate} not live after 60 min and nothing pending: manual action required`, true);
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * The publish call failed. Whatever the error (refusal, timeout, malformed answer), the request may have
 * reached the store: if our submission is pending, cancel it; a refusal with nothing pending is "not
 * eligible"; anything else needs a human.
 */
async function afterPublishError(deps: ReleaseDeps, e: unknown, candidate: string, base: string): Promise<RulesetReleaseResult> {
  const message = e instanceof Error ? e.message : String(e);
  let s: ItemStatus;
  try {
    s = await deps.client.status();
  } catch (statusError) {
    const why = statusError instanceof Error ? statusError.message : String(statusError);
    return failed(`publish failed (${message}) and the state is unknown (status: ${why}): manual action required`, true);
  }
  if (s.submitted?.version === candidate && hasPendingSubmission(s)) return cancelOurs(deps, base, candidate, `publish failed (${message})`);
  if (e instanceof StoreHttpError) return failed(`not eligible for skip review: ${message}`, false);
  return failed(`publish failed (${message}); nothing of ours is pending: manual action required`, true);
}

/** The candidate must be a scheme version on the live code line and later than what is live. */
function versionProblem(candidate: string, live: string): string | undefined {
  const v = decodeVersion(candidate);
  if (v === undefined) return `candidate ${candidate} is outside the version scheme`;
  const [major = 0, minor = 0] = live.split('.').map(Number);
  if (v.major !== major || v.minor !== minor) return `candidate ${candidate} is not on the live code line ${live}`;
  return compareVersions(candidate, live) > 0 ? undefined : `candidate ${candidate} is not later than the live ${live}`;
}

/** Runs the ruleset release of `zip`. Throws only on transport or contract errors before the publish call. */
export async function publishRulesetRelease(deps: ReleaseDeps, zip: Uint8Array): Promise<RulesetReleaseResult> {
  const candidate = zipManifestVersion(zip);
  const before = await deps.client.status();
  const blocked = e11(before);
  if (blocked !== undefined || before.publishedVersion === undefined) return { kind: 'skipped', reason: blocked ?? 'item is not published' };
  const base = before.publishedVersion;
  const bad = versionProblem(candidate, base);
  if (bad !== undefined) return failed(bad, false);
  const up = await deps.client.upload(zip);
  const uploadState = await waitForUpload(deps, up.state);
  if (uploadState !== 'SUCCEEDED') return failed(`upload ended ${uploadState}`, false);
  if (up.version !== candidate) return failed(`store read version ${up.version ?? 'none'}, expected ${candidate}`, true);
  const again = e11(await deps.client.status());
  if (again !== undefined) return { kind: 'skipped', reason: `${again} (re-checked before publish)` };
  deps.log(`publishing ${candidate} with skip review (live: ${base})`);
  try {
    await deps.client.publishSkipReview();
  } catch (e) {
    return afterPublishError(deps, e, candidate, base);
  }
  return pollUntilLive(deps, candidate, base);
}
