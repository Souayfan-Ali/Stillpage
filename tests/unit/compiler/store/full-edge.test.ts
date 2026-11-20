/**
 * Full release (P2-06) edge cases with a scripted client: version scheme, a store with no live version,
 * a taken-down item, uploads that stay in progress, fail or read another version, and a submit the
 * store does not show afterwards.
 */
import { describe, expect, test } from 'vitest';
import type { ItemStatus, StoreClient } from '../../../../compiler/store/client.js';
import { submitFullRelease, uploadFullRelease, type FullDeps } from '../../../../compiler/store/full.js';
import { extensionZip } from '../release/fixtures.js';

const VERSION = '1.1.321.600';
const ZIP = extensionZip({ version: VERSION });
const LIVE: ItemStatus = { publishedVersion: '1.0.320.600', warned: false, takenDown: false };

type Upload = Awaited<ReturnType<StoreClient['upload']>>;

interface Script {
  /** Status answers in order; the last one repeats. */
  readonly statuses?: readonly ItemStatus[];
  readonly upload?: Upload;
}

/** Deps over a scripted client and a clock that `sleep` advances. */
function scripted(script: Script = {}): FullDeps & { readonly published: () => number } {
  const statuses = script.statuses ?? [LIVE];
  let n = 0;
  let clock = 0;
  let published = 0;
  const client = {
    status: () => Promise.resolve(statuses[Math.min(n++, statuses.length - 1)] ?? LIVE),
    upload: () => Promise.resolve(script.upload ?? { state: 'SUCCEEDED' as const, version: VERSION }),
    publishWithReview: () => { published += 1; return Promise.resolve({}); },
  };
  return { client, now: () => clock, sleep: (ms: number) => { clock += ms; return Promise.resolve(); }, log: () => undefined, published: () => published };
}

describe('full release: version and item checks', () => {
  test('a version outside the scheme is refused before any upload', async () => {
    const bad = extensionZip({ version: '1.1.321.675' });
    expect(await uploadFullRelease(scripted(), bad)).toEqual({ kind: 'refused', reason: '1.1.321.675 is outside the version scheme' });
  });

  test('with no live version any in-scheme version is accepted', async () => {
    const d = scripted({ statuses: [{ warned: false, takenDown: false }] });
    expect(await uploadFullRelease(d, ZIP)).toEqual({ kind: 'uploaded', version: VERSION });
  });

  test('a live version with only a major part compares as MAJOR.0', async () => {
    const d = scripted({ statuses: [{ ...LIVE, publishedVersion: '1' }] });
    expect(await uploadFullRelease(d, ZIP)).toEqual({ kind: 'uploaded', version: VERSION });
  });

  test('a lower major is refused for not raising the code line', async () => {
    const d = scripted({ statuses: [{ ...LIVE, publishedVersion: '2.0.320.600' }] });
    expect(await uploadFullRelease(d, ZIP)).toEqual({ kind: 'refused', reason: `${VERSION} does not raise the code line of the live 2.0.320.600` });
  });

  test('a taken-down item is refused', async () => {
    const d = scripted({ statuses: [{ ...LIVE, takenDown: true }] });
    expect(await uploadFullRelease(d, ZIP)).toEqual({ kind: 'refused', reason: 'item is taken down' });
  });

  test('a pending submission without a version is named with a placeholder', async () => {
    const d = scripted({ statuses: [{ ...LIVE, submitted: { state: 'PENDING_REVIEW' } }] });
    expect(await uploadFullRelease(d, ZIP)).toEqual({ kind: 'refused', reason: 'a submission is pending (?)' });
  });
});

describe('full release: upload outcomes', () => {
  test('an upload in progress is polled until the store reports success', async () => {
    const d = scripted({ upload: { state: 'IN_PROGRESS', version: VERSION }, statuses: [LIVE, { ...LIVE, uploadState: 'IN_PROGRESS' }, { ...LIVE, uploadState: 'SUCCEEDED' }] });
    expect(await uploadFullRelease(d, ZIP)).toEqual({ kind: 'uploaded', version: VERSION });
  });

  test('an upload whose state the store never reports times out as in progress', async () => {
    const d = scripted({ upload: { state: 'IN_PROGRESS' } });
    expect(await uploadFullRelease(d, ZIP)).toEqual({ kind: 'failed', reason: 'upload ended IN_PROGRESS' });
  });

  test('a failed upload fails the release', async () => {
    expect(await uploadFullRelease(scripted({ upload: { state: 'FAILED' } }), ZIP)).toEqual({ kind: 'failed', reason: 'upload ended FAILED' });
  });

  test('an upload the store reads without a version fails', async () => {
    const r = await uploadFullRelease(scripted({ upload: { state: 'SUCCEEDED' } }), ZIP);
    expect(r).toEqual({ kind: 'failed', reason: `store read version none, expected ${VERSION}` });
  });
});

describe('full release: submit outcomes', () => {
  test('a failed re-upload stops the submit before publishing', async () => {
    const d = scripted({ upload: { state: 'FAILED' } });
    expect(await submitFullRelease(d, ZIP, VERSION)).toEqual({ kind: 'failed', reason: 'upload ended FAILED' });
    expect(d.published()).toBe(0);
  });

  test('a submit the store does not show afterwards needs a human', async () => {
    const d = scripted();
    expect(await submitFullRelease(d, ZIP, VERSION)).toEqual({ kind: 'failed', reason: `the store's submission is none, not the approved ${VERSION}: manual action required` });
    expect(d.published()).toBe(1);
  });
});
