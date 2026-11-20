/**
 * Chrome Web Store API v2 client (P2-04): status, upload, publish, cancel. One transport port (live `fetch`
 * or the recorded-contract fake); answers are schema-checked, and an HTTP error is an error, never a guess.
 * Skip review and standard review are two separate methods with fixed bodies, so the ruleset path
 * (`release.ts`) cannot ask for standard review by passing a flag.
 */
import type { StoreState } from '../eligibility/types.js';
import {
  checkItemRef, PublishResponseSchema, StatusResponseSchema, UploadResponseSchema, urls,
  type ItemRef, type ItemState, type PublishBody, type StoreResponse, type Transport,
} from './contract.ts';

/** The store's item status, reduced to what the release flow reads. */
export interface ItemStatus {
  readonly publishedVersion?: string;
  readonly submitted?: { readonly state: ItemState; readonly version?: string };
  readonly warned: boolean;
  readonly takenDown: boolean;
  /** State of the last asynchronous upload. */
  readonly uploadState?: UploadResult['state'];
}

interface UploadResult {
  readonly state: 'SUCCEEDED' | 'IN_PROGRESS' | 'FAILED' | 'NOT_FOUND' | 'UPLOAD_STATE_UNSPECIFIED';
  readonly version?: string;
}

export interface StoreClient {
  status(): Promise<ItemStatus>;
  upload(zip: Uint8Array): Promise<UploadResult>;
  /** Ruleset release: `skipReview: true`, always. */
  publishSkipReview(): Promise<{ readonly state?: ItemState }>;
  /** Full release: standard review, staged (deferred) publishing after approval (update-strategy notes §4). */
  publishWithReview(): Promise<{ readonly state?: ItemState }>;
  cancelSubmission(): Promise<void>;
}

const HTTP_OK = 200;
const SKIP_REVIEW: PublishBody = { publishType: 'DEFAULT_PUBLISH', skipReview: true };
const WITH_REVIEW: PublishBody = { publishType: 'STAGED_PUBLISH', skipReview: false };

/** Error for a non-200 answer; carries the store's message (an error text, never a credential). */
export class StoreHttpError extends Error {
  readonly what: string;
  readonly status: number;
  // Explicit fields, no parameter properties: plain `node` strips types only (D-71).
  constructor(what: string, status: number, detail: string) {
    super(`${what}: HTTP ${String(status)}${detail === '' ? '' : ` (${detail})`}`);
    this.name = 'StoreHttpError';
    this.what = what;
    this.status = status;
  }
}

const MAX_DETAIL = 200;
function detailOf(json: unknown): string {
  const message = (json as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message === 'string' ? message.slice(0, MAX_DETAIL) : '';
}

function parsed<T>(what: string, res: StoreResponse, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }): T {
  if (res.status !== HTTP_OK) throw new StoreHttpError(what, res.status, detailOf(res.json));
  const r = schema.safeParse(res.json);
  if (!r.success) throw new Error(`${what}: unexpected answer from the store`);
  return r.data;
}

const versionOf = (rev: { distributionChannels?: readonly { crxVersion?: string | undefined }[] | undefined } | undefined): string | undefined =>
  rev?.distributionChannels?.[0]?.crxVersion;

/** A client for `ref`; `token` yields a bearer token per request (service-account auth, `auth.ts`). */
export function createStoreClient(ref: ItemRef, transport: Transport, token: () => Promise<string>): StoreClient {
  const item = checkItemRef(ref);
  const send = async (method: 'GET' | 'POST', url: string, body?: Uint8Array | string, type?: string): Promise<StoreResponse> =>
    transport({ method, url, headers: { Authorization: `Bearer ${await token()}`, ...(type !== undefined && { 'Content-Type': type }) }, ...(body !== undefined && { body }) });
  const publish = async (body: PublishBody) => {
    const r = parsed('publish', await send('POST', urls.publish(item), JSON.stringify(body), 'application/json'), PublishResponseSchema);
    return r.state === undefined ? {} : { state: r.state };
  };
  return {
    async status() {
      const s = parsed('status', await send('GET', urls.status(item)), StatusResponseSchema);
      const publishedVersion = s.publishedItemRevisionStatus?.state === 'PUBLISHED' ? versionOf(s.publishedItemRevisionStatus) : undefined;
      const sub = s.submittedItemRevisionStatus;
      const subVersion = versionOf(sub);
      return { warned: s.warned ?? false, takenDown: s.takenDown ?? false, ...(publishedVersion !== undefined && { publishedVersion }),
        ...(s.lastAsyncUploadState !== undefined && { uploadState: s.lastAsyncUploadState }),
        ...(sub && { submitted: { state: sub.state, ...(subVersion !== undefined && { version: subVersion }) } }) };
    },
    async upload(zip) {
      const u = parsed('upload', await send('POST', urls.upload(item), zip, 'application/zip'), UploadResponseSchema);
      return { state: u.uploadState, ...(u.crxVersion !== undefined && { version: u.crxVersion }) };
    },
    publishSkipReview: () => publish(SKIP_REVIEW),
    publishWithReview: () => publish(WITH_REVIEW),
    async cancelSubmission() {
      const r = await send('POST', urls.cancel(item));
      if (r.status !== HTTP_OK) throw new StoreHttpError('cancelSubmission', r.status, detailOf(r.json));
    },
  };
}

const OPEN_STATES: ReadonlySet<ItemState> = new Set(['PENDING_REVIEW', 'STAGED']);

/** True when a submission is waiting for review or for publishing. */
export const hasPendingSubmission = (s: ItemStatus): boolean => s.submitted !== undefined && OPEN_STATES.has(s.submitted.state);

/** E11 input of the eligibility gate (P2-02) from a status answer. */
export function toStoreState(s: ItemStatus): StoreState {
  return { published: s.publishedVersion !== undefined && !s.takenDown, warned: s.warned || s.takenDown, pendingSubmission: hasPendingSubmission(s),
    ...(s.publishedVersion !== undefined && { publishedVersion: s.publishedVersion }) };
}
