/**
 * Receiving a message (P1-12, ADR-012 item 4): envelope → known type → sender policy → payload.
 * Never throws; every rejection carries an error code for the `{ ok: false, error }` response.
 */
import * as v from 'valibot';
import { MAX_ID_LENGTH } from '../limits.js';
import type { SkippedPack } from '../reconcile/types.js';
import type { Result } from '../result.js';
import { PAYLOAD_SCHEMAS, senderPolicyOf, type MessageType, type PayloadOf } from './schemas.js';
import { classifySender, isBlockedPage, type SenderInfo } from './sender.js';

export type { SenderInfo } from './sender.js';
export type { MessageType } from './schemas.js';

/** Envelope version of v1. */
const ENVELOPE_VERSION = 1;

export const MESSAGE_TYPES = Object.keys(PAYLOAD_SCHEMAS) as readonly MessageType[];

type ErrorCode =
  | 'invalid-envelope'
  | 'unknown-type'
  | 'forbidden-sender'
  | 'invalid-payload'
  | 'not-found'
  | 'no-capacity'
  | 'not-implemented'
  | 'internal';

export interface MessageError {
  readonly code: ErrorCode;
  /** Plain fallback text; pages word the error from `code` and `detail`. */
  readonly message: string;
  /** `no-capacity` (P2-26): which limit, what the pack needs and what is left. */
  readonly detail?: Omit<SkippedPack, 'pack'>;
}

/** A validated message. `senderTabId` / `senderFrameId` come from `sender`, never from the payload. */
export type ParsedMessage = {
  [T in MessageType]: {
    readonly type: T;
    readonly id: string;
    readonly payload: PayloadOf<T>;
    readonly senderTabId?: number;
    readonly senderFrameId?: number;
  };
}[MessageType];

/** Wire response (architecture notes §7). */
export type Response<D> = { readonly ok: true; readonly data: D } | { readonly ok: false; readonly error: MessageError };

/** Longest message type name (`c/setSitePopupPolicy` is 20). */
const MAX_TYPE_LENGTH = 32;

const EnvelopeSchema = v.strictObject({
  v: v.literal(ENVELOPE_VERSION),
  type: v.pipe(v.string(), v.maxLength(MAX_TYPE_LENGTH)),
  id: v.pipe(v.string(), v.regex(new RegExp(`^[A-Za-z0-9_-]{1,${String(MAX_ID_LENGTH)}}$`))),
  payload: v.unknown(),
});

const fail = (code: ErrorCode, message: string): Result<never, MessageError> => ({ ok: false, errors: { code, message } });

function isKnownType(type: string): type is MessageType {
  return Object.hasOwn(PAYLOAD_SCHEMAS, type);
}

function senderAllowed(type: MessageType, sender: SenderInfo, runtimeId: string): boolean {
  const policy = senderPolicyOf(type);
  if (policy === 'blocked-page') return isBlockedPage(sender, runtimeId);
  return classifySender(sender, runtimeId) === policy;
}

function senderFields(sender: SenderInfo): { senderTabId?: number; senderFrameId?: number } {
  return {
    ...(sender.tab?.id === undefined ? {} : { senderTabId: sender.tab.id }),
    ...(sender.frameId === undefined ? {} : { senderFrameId: sender.frameId }),
  };
}

/** Validates `raw` as a v1 message from `sender`. */
export function parseMessage(raw: unknown, sender: SenderInfo, runtimeId: string): Result<ParsedMessage, MessageError> {
  const envelope = v.safeParse(EnvelopeSchema, raw);
  if (!envelope.success) return fail('invalid-envelope', 'malformed envelope');
  const { type, id, payload } = envelope.output;
  if (!isKnownType(type)) return fail('unknown-type', 'unknown message type');
  if (!senderAllowed(type, sender, runtimeId)) return fail('forbidden-sender', `sender may not send ${type}`);
  const parsed = v.safeParse(PAYLOAD_SCHEMAS[type], payload);
  if (!parsed.success) return fail('invalid-payload', `invalid payload for ${type}`);
  const withTab = type === 'c/proceedOnce' || type === 'cs/cssFallback';
  const message = { type, id, payload: parsed.output, ...(withTab ? senderFields(sender) : {}) } as ParsedMessage;
  return { ok: true, value: message };
}
