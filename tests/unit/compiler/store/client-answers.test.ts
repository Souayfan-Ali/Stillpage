/**
 * Store client (P2-04): how sparse or unusual answers are reduced, and how HTTP errors are worded.
 */
import { describe, expect, test } from 'vitest';
import { createStoreClient, StoreHttpError } from '../../../../compiler/store/client.js';
import type { Transport } from '../../../../compiler/store/contract.js';
import { FAKE_ITEM } from '../../../../compiler/store/fake.js';

const answering = (status: number, json: unknown) => createStoreClient(FAKE_ITEM, (() => Promise.resolve({ status, json })) satisfies Transport, () => Promise.resolve('t'));

describe('store client: status answers', () => {
  test('a bare answer reads as not warned, not taken down, nothing published or submitted', async () => {
    expect(await answering(200, {}).status()).toEqual({ warned: false, takenDown: false });
  });

  test('a published revision that is not in state PUBLISHED gives no live version', async () => {
    const json = { publishedItemRevisionStatus: { state: 'STAGED', distributionChannels: [{ crxVersion: '1.0.1.600' }] }, warned: true, takenDown: true };
    expect(await answering(200, json).status()).toEqual({ warned: true, takenDown: true });
  });

  test('a submitted revision without channels carries its state only; the upload state is kept', async () => {
    const json = { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' }, lastAsyncUploadState: 'IN_PROGRESS' };
    expect(await answering(200, json).status()).toEqual({ warned: false, takenDown: false, uploadState: 'IN_PROGRESS', submitted: { state: 'PENDING_REVIEW' } });
  });
});

describe('store client: publish answers and errors', () => {
  test('a publish answer with a state returns it; one without returns nothing', async () => {
    expect(await answering(200, { state: 'PENDING_REVIEW' }).publishSkipReview()).toEqual({ state: 'PENDING_REVIEW' });
    expect(await answering(200, {}).publishWithReview()).toEqual({});
  });

  test('an HTTP error without a store message has no detail in parentheses', async () => {
    await expect(answering(500, undefined).status()).rejects.toThrow(/^status: HTTP 500$/);
    await expect(answering(403, { error: { message: 7 } }).upload(new Uint8Array())).rejects.toThrow(/^upload: HTTP 403$/);
  });

  test('a refused cancel is a StoreHttpError carrying the store message', async () => {
    const error = await answering(400, { error: { message: 'nothing to cancel' } }).cancelSubmission().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreHttpError);
    expect(error).toMatchObject({ what: 'cancelSubmission', status: 400, message: 'cancelSubmission: HTTP 400 (nothing to cancel)' });
  });
});
