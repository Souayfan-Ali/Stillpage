import { describe, expect, test } from 'vitest';
import { createStoreClient, StoreHttpError, type StoreClient } from '../../../../compiler/store/client.js';
import { urls } from '../../../../compiler/store/contract.js';
import { FAKE_ITEM, fakeStore, type FakeScript } from '../../../../compiler/store/fake.js';
import { classifyPoll, publishRulesetRelease, REVIEW_GRACE_MS } from '../../../../compiler/store/release.js';
import { extensionZip } from '../release/fixtures.js';

const CANDIDATE = '1.0.318.600';
const ZIP = extensionZip({ version: CANDIDATE });

async function run(script: FakeScript) {
  const fake = fakeStore(script);
  let clock = 0;
  const lines: string[] = [];
  const result = await publishRulesetRelease({
    client: createStoreClient(FAKE_ITEM, fake.transport, () => Promise.resolve('fake-access-token')),
    now: () => clock, sleep: (ms) => { clock += ms; return Promise.resolve(); }, log: (l) => { lines.push(l); },
  }, ZIP);
  const calls = fake.log.map((l) => l.url.slice(l.url.lastIndexOf(":")));
  return { result, calls, log: fake.log, elapsed: clock, lines };
}

const BASE: FakeScript = { publishedVersion: '1.0.317.600', publish: 'live' };

describe('ruleset release through skip review (update-strategy notes §3.4, P2-04)', () => {
  test('upload → publish with skip review → poll until the candidate is live', async () => {
    const r = await run({ ...BASE, pollsUntilLive: 2 });
    expect(r.result).toEqual({ kind: 'live', version: CANDIDATE });
    expect(r.calls).toEqual([':fetchStatus', ':upload', ':fetchStatus', ':publish', ':fetchStatus', ':fetchStatus', ':fetchStatus']);
  });

  test('waits for an upload that is still processing', async () => {
    const r = await run({ ...BASE, uploadStates: ['IN_PROGRESS', 'SUCCEEDED'] });
    expect(r.result.kind).toBe('live');
    expect(r.calls.filter((c) => c === ':upload')).toHaveLength(1);
  });

  test('a failed upload stops before any publish', async () => {
    const r = await run({ ...BASE, uploadStates: ['FAILED'] });
    expect(r.result).toMatchObject({ kind: 'failed', manualAction: false });
    expect(r.calls).not.toContain(':publish');
  });

  test('E11 before upload: a pending submission skips the run without uploading', async () => {
    const r = await run({ ...BASE, pending: { version: '1.1.318.0', state: 'PENDING_REVIEW' } });
    expect(r.result.kind).toBe('skipped');
    expect(r.calls).toEqual([':fetchStatus']);
  });

  test('E11 again before publish: a submission that appeared meanwhile skips the publish', async () => {
    const r = await run({ ...BASE, pendingAppearsAfterUpload: { version: '1.1.318.0' } });
    expect(r.result.kind).toBe('skipped');
    expect(r.calls).not.toContain(':publish');
  });

  test('never falls back to standard review: still in review after the grace period → cancel our submission', async () => {
    const r = await run({ ...BASE, publish: 'stays-in-review' });
    expect(r.result).toMatchObject({ kind: 'failed', manualAction: false });
    expect(r.calls.filter((c) => c === ':cancelSubmission')).toHaveLength(1);
    expect(r.elapsed).toBeGreaterThan(REVIEW_GRACE_MS);
    expect(r.calls.at(-1)).toBe(':fetchStatus');
    expect(r.log.filter((l) => l.url === urls.publish(FAKE_ITEM)).map((l) => l.body)).toEqual([{ publishType: 'DEFAULT_PUBLISH', skipReview: true }]);
  });

  test('a refused skip-review publish fails without a cancel once nothing is pending', async () => {
    const r = await run({ ...BASE, publish: 'refused' });
    expect(r.result).toMatchObject({ kind: 'failed', manualAction: false });
    expect(r.result.kind === 'failed' && r.result.reason).toMatch(/not eligible|HTTP 400/);
    expect(r.calls).not.toContain(':cancelSubmission');
  });

  test('a cancel that fails asks for manual action and does not retry', async () => {
    const r = await run({ ...BASE, publish: 'stays-in-review', cancelFails: true });
    expect(r.result).toMatchObject({ kind: 'failed', manualAction: true });
    expect(r.calls.filter((c) => c === ':cancelSubmission')).toHaveLength(1);
  });
});

describe('poll classifier (the one place S-12 corrects)', () => {
  const status = (submitted?: { state: 'PENDING_REVIEW' | 'REJECTED' | 'STAGED'; version: string }, published = '1.0.317.600') =>
    ({ publishedVersion: published, warned: false, takenDown: false, ...(submitted && { submitted }) });
  test.each([
    ['live', status(undefined, CANDIDATE), 0],
    ['waiting', status({ state: 'PENDING_REVIEW', version: CANDIDATE }), REVIEW_GRACE_MS - 1],
    ['cancel', status({ state: 'PENDING_REVIEW', version: CANDIDATE }), REVIEW_GRACE_MS + 1],
    ['rejected', status({ state: 'REJECTED', version: CANDIDATE }), 0],
    ['foreign', status({ state: 'PENDING_REVIEW', version: '1.1.0.0' }), 0],
    ['waiting', status(), 0],
  ] as const)('%s', (expected, s, elapsed) => {
    expect(classifyPoll(s, CANDIDATE, elapsed)).toBe(expected);
  });
});

describe('ruleset release edge cases (scripted client)', () => {
  type Status = Awaited<ReturnType<StoreClient['status']>>;
  const live = (v = '1.0.317.600'): Status => ({ publishedVersion: v, warned: false, takenDown: false });
  /** A client whose status answers come from `statuses` in order (the last repeats). */
  function scripted(statuses: readonly Status[], over: Partial<StoreClient> = {}): { client: StoreClient; cancels: () => number } {
    let i = 0;
    let cancels = 0;
    const client: StoreClient = {
      status: () => Promise.resolve(statuses[Math.min(i++, statuses.length - 1)] ?? live()),
      upload: () => Promise.resolve({ state: 'SUCCEEDED', version: CANDIDATE }),
      publishSkipReview: () => Promise.resolve({}),
      publishWithReview: () => Promise.reject(new Error('never called')),
      cancelSubmission: () => { cancels++; return Promise.resolve(); },
      ...over,
    };
    return { client, cancels: () => cancels };
  }
  const go = (client: StoreClient) => {
    let clock = 0;
    return publishRulesetRelease({ client, now: () => clock, sleep: (ms) => { clock += ms; return Promise.resolve(); }, log: () => undefined }, ZIP);
  };
  const ours = (state: 'PENDING_REVIEW' | 'REJECTED', version = CANDIDATE): Status => ({ ...live(), submitted: { state, version } });

  test('a warned or unpublished item is skipped', async () => {
    expect((await go(scripted([{ ...live(), warned: true }]).client)).kind).toBe('skipped');
    expect((await go(scripted([{ warned: false, takenDown: false }]).client)).kind).toBe('skipped');
  });

  test('the store reading another version from the upload needs a human', async () => {
    const r = await go(scripted([live()], { upload: () => Promise.resolve({ state: 'SUCCEEDED', version: '9.9.9.9' }) }).client);
    expect(r).toMatchObject({ kind: 'failed', manualAction: true });
  });

  test('a rejected submission, a foreign one, or nothing live after 60 min fails', async () => {
    expect(await go(scripted([live(), live(), ours('REJECTED')]).client)).toMatchObject({ kind: 'failed', manualAction: false });
    const foreign = scripted([live(), live(), ours('PENDING_REVIEW', '1.1.0.0')]);
    expect(await go(foreign.client)).toMatchObject({ kind: 'failed', manualAction: true });
    expect(foreign.cancels()).toBe(0);
    expect(await go(scripted([live()]).client)).toMatchObject({ kind: 'failed', manualAction: true });
  });

  test('a refused publish with our submission pending anyway cancels it', async () => {
    const refusal = () => Promise.reject(new StoreHttpError('publish', 400, 'not eligible'));
    const s = scripted([live(), live(), ours('PENDING_REVIEW'), ours('PENDING_REVIEW'), live()], { publishSkipReview: refusal });
    expect(await go(s.client)).toMatchObject({ kind: 'failed', manualAction: false });
    expect(s.cancels()).toBe(1);
  });

  test('a state after cancel that is not the base needs a human; a transport error on publish is never assumed harmless', async () => {
    const s = scripted([live(), live(), ours('PENDING_REVIEW'), ours('PENDING_REVIEW'), ours('PENDING_REVIEW')]);
    let clock = 0;
    const r = await publishRulesetRelease({ client: s.client, now: () => clock, sleep: (ms) => { clock += ms; return Promise.resolve(); }, log: () => undefined }, ZIP);
    expect(r).toMatchObject({ kind: 'failed', manualAction: true });
    const broken = scripted([live()], { publishSkipReview: () => Promise.reject(new Error('socket hang up')) });
    expect(await go(broken.client)).toMatchObject({ kind: 'failed', manualAction: true });
    const brokenPending = scripted([live(), live(), ours('PENDING_REVIEW'), ours('PENDING_REVIEW'), live()], { publishSkipReview: () => Promise.reject(new Error('socket hang up')) });
    expect(await go(brokenPending.client)).toMatchObject({ kind: 'failed', manualAction: false });
    expect(brokenPending.cancels()).toBe(1);
  });

  test('a candidate that is not later than the live version, or on another code line, is never uploaded', async () => {
    let uploads = 0;
    const counting = { upload: () => { uploads++; return Promise.resolve({ state: 'SUCCEEDED' as const, version: CANDIDATE }); } };
    expect(await go(scripted([live(CANDIDATE)], counting).client)).toMatchObject({ kind: 'failed' });
    expect(await go(scripted([live('2.0.1.0')], counting).client)).toMatchObject({ kind: 'failed' });
    expect(uploads).toBe(0);
  });

  test('a submission that changed hands before the cancel is left alone', async () => {
    const s = scripted([live(), live(), ours('PENDING_REVIEW'), ours('PENDING_REVIEW', '1.1.0.0')], { publishSkipReview: () => Promise.reject(new StoreHttpError('publish', 400, 'x')) });
    expect(await go(s.client)).toMatchObject({ kind: 'failed', manualAction: true });
    expect(s.cancels()).toBe(0);
  });
});
