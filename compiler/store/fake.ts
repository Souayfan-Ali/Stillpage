/**
 * Recorded-contract fake of the Chrome Web Store API v2 (P2-04): the dry-run transport and the test double.
 * It answers the routes of `contract.ts` from a script and logs every request, so tests and the dry-run CLI
 * can show exactly what a live run would send. It never touches the network.
 *
 * Assumptions it encodes (UNVERIFIED until S-12, see `contract.ts`): an eligible skip-review publish answers
 * `PUBLISHED` or a short `PENDING_REVIEW` that turns `PUBLISHED`; an ineligible one either answers HTTP 400
 * or leaves the submission in `PENDING_REVIEW`.
 */
import { zipManifestVersion } from '../release/zipVersion.ts';
import { urls, type ItemRef, type ItemState, type StoreRequest, type StoreResponse, type Transport, TOKEN_URL } from './contract.ts';

export const FAKE_ITEM: ItemRef = { publisherId: 'fake-publisher', itemId: 'fakeitemidfakeitemidfakeitemidfa' };

export interface FakeScript {
  /** Version live before the run. */
  readonly publishedVersion: string;
  readonly warned?: boolean;
  /** A submission already waiting (for example a full release in review). */
  readonly pending?: { readonly version: string; readonly state: ItemState };
  /** Upload answers in order; the last repeats. Default: `SUCCEEDED`. */
  readonly uploadStates?: readonly ('SUCCEEDED' | 'IN_PROGRESS' | 'FAILED')[];
  /** What a skip-review publish does: go live after `pollsUntilLive` status calls, stay in review, or be refused. */
  readonly publish?: 'live' | 'stays-in-review' | 'refused';
  readonly pollsUntilLive?: number;
  readonly cancelFails?: boolean;
  /** A submission that appears after the upload (a human's full release, say). */
  readonly pendingAppearsAfterUpload?: { readonly version: string };
  /** A draft uploaded earlier (another process, e.g. the job before an approval). */
  readonly draft?: string;
}

export interface FakeStore {
  readonly transport: Transport;
  /** Every request, with the bearer token replaced, in order. */
  readonly log: readonly { readonly method: string; readonly url: string; readonly body?: unknown }[];
}

const ok = (json: unknown): StoreResponse => ({ status: 200, json });
const revision = (state: ItemState, version: string): object => ({ state, distributionChannels: [{ crxVersion: version, deployPercentage: 100 }] });

/** Version inside an uploaded zip, as the store reads it (`crxVersion`). */
const versionOf = (body: StoreRequest['body']): string =>
  (body instanceof Uint8Array ? zipManifestVersion(body) : '0');

function bodyOf(r: StoreRequest): unknown {
  if (typeof r.body !== 'string') return r.body === undefined ? undefined : `<${String(r.body.length)} bytes>`;
  try { return JSON.parse(r.body) as unknown; } catch { return '<form>'; }
}

/** A fake store driven by `script`. */
export function fakeStore(script: FakeScript, ref: ItemRef = FAKE_ITEM): FakeStore {
  const log: { method: string; url: string; body?: unknown }[] = [];
  let published = script.publishedVersion;
  let pending = script.pending;
  let uploaded: string | undefined = script.draft;
  let uploads = 0;
  let pollsLeft = script.pollsUntilLive ?? 0;
  const status = (): StoreResponse => {
    if (pending?.state === 'PENDING_REVIEW' && script.publish === 'live' && pending.version === uploaded && pollsLeft-- <= 0) {
      published = pending.version;
      pending = undefined;
    }
    return ok({ itemId: ref.itemId, warned: script.warned ?? false, takenDown: false, publishedItemRevisionStatus: revision('PUBLISHED', published),
      ...(pending && { submittedItemRevisionStatus: revision(pending.state, pending.version) }), lastAsyncUploadState: 'SUCCEEDED' });
  };
  const routes: Readonly<Record<string, (r: StoreRequest) => StoreResponse>> = {
    [TOKEN_URL]: () => ok({ access_token: 'fake-access-token', expires_in: 3600, token_type: 'Bearer' }),
    [urls.status(ref)]: status,
    [urls.upload(ref)]: (r) => {
      const states = script.uploadStates ?? ['SUCCEEDED'];
      const state = states[Math.min(uploads++, states.length - 1)] ?? 'SUCCEEDED';
      uploaded = versionOf(r.body);
      if (script.pendingAppearsAfterUpload) pending = { version: script.pendingAppearsAfterUpload.version, state: 'PENDING_REVIEW' };
      return ok({ itemId: ref.itemId, crxVersion: uploaded, uploadState: state });
    },
    [urls.publish(ref)]: () => {
      if (script.publish === 'refused') return { status: 400, json: { error: { code: 400, message: 'Item is not eligible for skip review.' } } };
      pending = { version: uploaded ?? '0', state: 'PENDING_REVIEW' };
      return ok({ itemId: ref.itemId, state: 'PENDING_REVIEW' });
    },
    [urls.cancel(ref)]: () => {
      if (script.cancelFails) return { status: 500, json: { error: { code: 500, message: 'backend error' } } };
      pending = undefined;
      return ok({});
    },
  };
  const transport: Transport = (r) => {
    const body = bodyOf(r);
    log.push({ method: r.method, url: r.url, ...(body !== undefined && { body }) });
    const route = Object.hasOwn(routes, r.url) ? routes[r.url] : undefined;
    return Promise.resolve(route ? route(r) : { status: 404, json: { error: { code: 404, message: 'not found' } } });
  };
  return { transport, log };
}
