/**
 * Chrome Web Store API v2 contract as used by the store client (update-strategy notes §3.4, research notes 03 §7.3, P2-04).
 *
 * RECORDED FROM DOCUMENTATION, UNVERIFIED: endpoint shapes, field names and state names were written from the
 * public v2 reference, not observed. S-12 (NEEDS MAINTAINER: developer account, unlisted item) must check them
 * against the live API and correct this file and `fake.ts` together. In particular it is not known how the
 * store answers a skip-review publish that is not eligible (an HTTP error, or a submission left in
 * `PENDING_REVIEW`); `classifyPoll` in `release.ts` holds that assumption in one place.
 *
 * Dependency-free (D-71): the answer guards are hand-written (no zod), so the key-holding publish job runs this
 * with plain `node` and no npm package. They accept and refuse what the earlier zod schemas did (pinned by
 * `tests/unit/compiler/store/uploader.test.ts`); unknown keys are kept.
 */

const STORE_API = 'https://chromewebstore.googleapis.com';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const STORE_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

/** The store item: both ids come from config, never from code (placeholders until the owner supplies them). */
export interface ItemRef {
  readonly publisherId: string;
  readonly itemId: string;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Validates ids before they are put into a URL path. */
export function checkItemRef(ref: ItemRef): ItemRef {
  if (!ID.test(ref.publisherId) || !ID.test(ref.itemId)) throw new Error('publisherId and itemId must be plain ids');
  return ref;
}

const itemPath = (ref: ItemRef): string => `publishers/${ref.publisherId}/items/${ref.itemId}`;

export const urls = {
  upload: (ref: ItemRef): string => `${STORE_API}/upload/v2/${itemPath(ref)}:upload`,
  status: (ref: ItemRef): string => `${STORE_API}/v2/${itemPath(ref)}:fetchStatus`,
  publish: (ref: ItemRef): string => `${STORE_API}/v2/${itemPath(ref)}:publish`,
  cancel: (ref: ItemRef): string => `${STORE_API}/v2/${itemPath(ref)}:cancelSubmission`,
};

const UPLOAD_STATES = ['SUCCEEDED', 'IN_PROGRESS', 'FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED'] as const;
const ITEM_STATES = ['STATE_UNSPECIFIED', 'PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS', 'REJECTED', 'CANCELLED'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** A schema-like guard: `safeParse` as the client reads it. */
export interface AnswerGuard<T> {
  safeParse(value: unknown): { readonly success: true; readonly data: T } | { readonly success: false };
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const optional = (v: unknown, test: (x: unknown) => boolean): boolean => v === undefined || test(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = (values: readonly string[]) => (v: unknown): boolean => typeof v === 'string' && values.includes(v);

function guard<T>(test: (v: Json) => boolean): AnswerGuard<T> {
  return { safeParse: (value) => (isRecord(value) && test(value) ? { success: true, data: value as T } : { success: false }) };
}

type UploadState = (typeof UPLOAD_STATES)[number];
interface Channel { readonly crxVersion?: string; readonly deployPercentage?: number }
interface Revision { readonly state: ItemState; readonly distributionChannels?: readonly Channel[] }

const isChannel = (v: unknown): boolean => isRecord(v) && optional(v['crxVersion'], isString) && optional(v['deployPercentage'], isNumber);
const isRevision = (v: unknown): boolean => isRecord(v) && oneOf(ITEM_STATES)(v['state'])
  && optional(v['distributionChannels'], (c) => Array.isArray(c) && c.every(isChannel));

export const TokenResponseSchema = guard<{ readonly access_token: string; readonly expires_in: number; readonly token_type: string }>((v) =>
  isString(v['access_token']) && v['access_token'] !== '' && Number.isSafeInteger(v['expires_in']) && (v['expires_in'] as number) > 0 && isString(v['token_type']));

export const UploadResponseSchema = guard<{ readonly itemId?: string; readonly crxVersion?: string; readonly uploadState: UploadState }>((v) =>
  optional(v['itemId'], isString) && optional(v['crxVersion'], isString) && oneOf(UPLOAD_STATES)(v['uploadState']));

export const StatusResponseSchema = guard<{
  readonly itemId?: string; readonly publishedItemRevisionStatus?: Revision; readonly submittedItemRevisionStatus?: Revision;
  readonly lastAsyncUploadState?: UploadState; readonly takenDown?: boolean; readonly warned?: boolean;
}>((v) => optional(v['itemId'], isString) && optional(v['publishedItemRevisionStatus'], isRevision) && optional(v['submittedItemRevisionStatus'], isRevision)
  && optional(v['lastAsyncUploadState'], oneOf(UPLOAD_STATES)) && optional(v['takenDown'], isBoolean) && optional(v['warned'], isBoolean));

export const PublishResponseSchema = guard<{ readonly itemId?: string; readonly state?: ItemState }>((v) =>
  optional(v['itemId'], isString) && optional(v['state'], oneOf(ITEM_STATES)));

/** Body of a publish request. `skipReview` is set by the client method, never by a caller. */
export interface PublishBody {
  readonly publishType: 'DEFAULT_PUBLISH' | 'STAGED_PUBLISH';
  readonly skipReview: boolean;
}

export interface StoreRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
}

export interface StoreResponse {
  readonly status: number;
  /** Parsed JSON body (`undefined` when empty or not JSON). */
  readonly json: unknown;
}

/** The one I/O port of the client: the live `fetch` wrapper, or the recorded-contract fake. */
export type Transport = (request: StoreRequest) => Promise<StoreResponse>;
