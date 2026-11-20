import { describe, expect, test } from 'vitest';
import { createStoreClient } from '../../../../compiler/store/client.js';
import { FAKE_ITEM, fakeStore, type FakeScript } from '../../../../compiler/store/fake.js';
import { submitFullRelease, uploadFullRelease } from '../../../../compiler/store/full.js';
import { extensionZip } from '../release/fixtures.js';

const ZIP = extensionZip({ version: '1.1.321.600' });

function deps(script: FakeScript) {
  const fake = fakeStore(script);
  let clock = 0;
  return { fake, deps: { client: createStoreClient(FAKE_ITEM, fake.transport, () => Promise.resolve('t')), now: () => clock,
    sleep: (ms: number) => { clock += ms; return Promise.resolve(); }, log: () => undefined } };
}
const calls = (f: ReturnType<typeof fakeStore>) => f.log.map((l) => l.url.slice(l.url.lastIndexOf(':')));

describe('full release: draft upload, then submit for review after approval (update-strategy notes §4, P2-06)', () => {
  test('upload stores a draft and never publishes', async () => {
    const { fake, deps: d } = deps({ publishedVersion: '1.0.320.600' });
    expect(await uploadFullRelease(d, ZIP)).toEqual({ kind: 'uploaded', version: '1.1.321.600' });
    expect(calls(fake)).toEqual([':fetchStatus', ':upload']);
  });

  test('a full release must raise the code line and be later than the live version', async () => {
    const same = extensionZip({ version: '1.0.321.600' });
    expect((await uploadFullRelease(deps({ publishedVersion: '1.0.320.600' }).deps, same)).kind).toBe('refused');
    expect((await uploadFullRelease(deps({ publishedVersion: '1.2.320.600' }).deps, ZIP)).kind).toBe('refused');
  });

  test('a pending submission (a ruleset release, say) blocks the upload', async () => {
    const { fake, deps: d } = deps({ publishedVersion: '1.0.320.600', pending: { version: '1.0.321.0', state: 'PENDING_REVIEW' } });
    expect((await uploadFullRelease(d, ZIP)).kind).toBe('refused');
    expect(calls(fake)).toEqual([':fetchStatus']);
  });

  test('submit asks for standard review with staged publishing and reports the pending state', async () => {
    const { fake, deps: d } = deps({ publishedVersion: '1.0.320.600' });
    await uploadFullRelease(d, ZIP);
    expect(await submitFullRelease(d, ZIP, '1.1.321.600')).toEqual({ kind: 'submitted', version: '1.1.321.600' });
    expect(fake.log.at(-2)?.body).toEqual({ publishType: 'STAGED_PUBLISH', skipReview: false });
    expect(calls(fake).slice(-4)).toEqual([':fetchStatus', ':upload', ':publish', ':fetchStatus']);
  });

  test('submit re-uploads the approved bytes even if the draft was replaced meanwhile', async () => {
    const { deps: d } = deps({ publishedVersion: '1.0.320.600', draft: '1.0.321.0' });
    expect(await submitFullRelease(d, ZIP, '1.1.321.600')).toEqual({ kind: 'submitted', version: '1.1.321.600' });
  });

  test('submit refuses a zip that is not the approved version, or while something is pending', async () => {
    const { fake, deps: d } = deps({ publishedVersion: '1.0.320.600' });
    expect((await submitFullRelease(d, ZIP, '1.1.322.600')).kind).toBe('refused');
    expect(calls(fake)).toEqual([]);
    const pending = deps({ publishedVersion: '1.0.320.600', pending: { version: '1.0.321.0', state: 'PENDING_REVIEW' } });
    expect((await submitFullRelease(pending.deps, ZIP, '1.1.321.600')).kind).toBe('refused');
  });

  test('a store that reports another submission after the submit needs a human', async () => {
    let submitted = false;
    const client = {
      status: () => Promise.resolve(submitted ? { publishedVersion: '1.0.320.600', warned: false, takenDown: false, submitted: { state: 'PENDING_REVIEW' as const, version: '1.0.321.0' } }
        : { publishedVersion: '1.0.320.600', warned: false, takenDown: false }),
      upload: () => Promise.resolve({ state: 'SUCCEEDED' as const, version: '1.1.321.600' }),
      publishWithReview: () => { submitted = true; return Promise.resolve({}); },
    };
    const r = await submitFullRelease({ client, now: () => 0, sleep: () => Promise.resolve(), log: () => undefined }, ZIP, '1.1.321.600');
    expect(r).toMatchObject({ kind: 'failed' });
  });
});
