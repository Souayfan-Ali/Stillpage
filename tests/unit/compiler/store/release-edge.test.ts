/**
 * Ruleset release (P2-04) edge cases with a scripted client: versions outside the scheme, uploads that
 * never settle or read no version, publish and cancel calls that throw non-Error values, a status call
 * that fails after a failed publish, and submissions that carry no version.
 */
import { describe, expect, test } from 'vitest';
import type { ItemStatus, StoreClient } from '../../../../compiler/store/client.js';
import { publishRulesetRelease, type ReleaseDeps } from '../../../../compiler/store/release.js';
import { extensionZip } from '../release/fixtures.js';

const CANDIDATE = '1.0.318.600';
const ZIP = extensionZip({ version: CANDIDATE });
const LIVE: ItemStatus = { publishedVersion: '1.0.317.600', warned: false, takenDown: false };
const OURS: ItemStatus = { ...LIVE, submitted: { state: 'PENDING_REVIEW', version: CANDIDATE } };

type Upload = Awaited<ReturnType<StoreClient['upload']>>;

/**
 * A thrown value that is not an `Error` (a string-like object), typed as one so the fake can reject with
 * it: the release flow must word such values with `String(e)`.
 */
const nonError = (text: string): Error => ({ toString: () => text }) as unknown as Error;
/** A status call that throws `error` instead of answering. */
interface Throws { readonly throws: Error }

interface Script {
  /** Status answers in order; the last repeats. */
  readonly statuses?: readonly (ItemStatus | Throws)[];
  readonly upload?: Upload;
  readonly publishThrows?: Error;
  readonly cancelThrows?: Error;
}

function client(script: Script): ReleaseDeps['client'] {
  const statuses = script.statuses ?? [LIVE];
  let n = 0;
  return {
    status: () => {
      const s = statuses[Math.min(n++, statuses.length - 1)] ?? LIVE;
      return 'throws' in s ? Promise.reject(s.throws) : Promise.resolve(s);
    },
    upload: () => Promise.resolve(script.upload ?? { state: 'SUCCEEDED' as const, version: CANDIDATE }),
    publishSkipReview: () => (script.publishThrows === undefined ? Promise.resolve({}) : Promise.reject(script.publishThrows)),
    cancelSubmission: () => (script.cancelThrows === undefined ? Promise.resolve() : Promise.reject(script.cancelThrows)),
  };
}

function run(script: Script = {}, zip: Uint8Array = ZIP) {
  let clock = 0;
  return publishRulesetRelease({ client: client(script), now: () => clock, sleep: (ms) => { clock += ms; return Promise.resolve(); }, log: () => undefined }, zip);
}

describe('ruleset release: before the publish call', () => {
  test('a candidate outside the version scheme fails without manual action', async () => {
    expect(await run({}, extensionZip({ version: '1.0.318.675' }))).toEqual({ kind: 'failed', reason: 'candidate 1.0.318.675 is outside the version scheme', manualAction: false });
  });

  test('an upload whose state the store never reports times out as in progress', async () => {
    expect(await run({ upload: { state: 'IN_PROGRESS' } })).toEqual({ kind: 'failed', reason: 'upload ended IN_PROGRESS', manualAction: false });
  });

  test('an upload read without a version needs a human', async () => {
    expect(await run({ upload: { state: 'SUCCEEDED' } })).toEqual({ kind: 'failed', reason: `store read version none, expected ${CANDIDATE}`, manualAction: true });
  });
});

describe('ruleset release: a failed publish call', () => {
  test('a non-Error refusal with nothing pending needs a human', async () => {
    const r = await run({ publishThrows: nonError('boom') });
    expect(r).toEqual({ kind: 'failed', reason: 'publish failed (boom); nothing of ours is pending: manual action required', manualAction: true });
  });

  test('a status call that fails afterwards leaves the state unknown', async () => {
    const r = await run({ publishThrows: new Error('reset'), statuses: [LIVE, LIVE, { throws: new Error('timeout') }] });
    expect(r).toEqual({ kind: 'failed', reason: 'publish failed (reset) and the state is unknown (status: timeout): manual action required', manualAction: true });
  });

  test('a non-Error thrown by that status call is reported as text', async () => {
    const r = await run({ publishThrows: new Error('reset'), statuses: [LIVE, LIVE, { throws: nonError('down') }] });
    expect(r).toMatchObject({ reason: 'publish failed (reset) and the state is unknown (status: down): manual action required' });
  });

  test('our pending submission is cancelled; a non-Error cancel failure needs a human', async () => {
    const r = await run({ publishThrows: new Error('reset'), statuses: [LIVE, LIVE, OURS, OURS], cancelThrows: nonError('nope') });
    expect(r).toEqual({ kind: 'failed', reason: 'publish failed (reset); cancel failed (nope): manual action required', manualAction: true });
  });

  test('a submission gone by the time of the cancel is not ours any more', async () => {
    const r = await run({ publishThrows: new Error('reset'), statuses: [LIVE, LIVE, OURS, LIVE] });
    expect(r).toEqual({ kind: 'failed', reason: 'publish failed (reset); the pending submission is no longer ours (none): manual action required', manualAction: true });
  });
});

describe('ruleset release: polling', () => {
  test('a pending submission without a version is foreign and named with a placeholder', async () => {
    const r = await run({ statuses: [LIVE, LIVE, { ...LIVE, submitted: { state: 'PENDING_REVIEW' } }] });
    expect(r).toEqual({ kind: 'failed', reason: 'another submission (?) is pending: manual action required', manualAction: true });
  });
});
