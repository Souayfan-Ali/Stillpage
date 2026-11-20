/**
 * The settings pages' side of the P1-12 envelope (dashboard and onboarding): builds
 * `{ v: 1, type, id, payload }`, sends it through the page transport and validates every answer with
 * a schema before anything is drawn from it (an answer is a boundary too). Refusals keep the worker's
 * `code` and, for `no-capacity`, its validated `detail`, so the page can word the error (P2-26).
 * Never throws: every failure is a typed `PageError`.
 */
import * as v from 'valibot';
import { PAYLOAD_SCHEMAS, type MessageType, type PayloadOf } from '../../core/messaging/schemas.js';

const ENVELOPE_VERSION = 1;
const ID_BYTES = 9;
/**
 * A worker that has not answered by then is treated as gone. Long on purpose: a pack command answers
 * after the run that persists the pack's registrations, which takes tens of seconds on a loaded machine
 * (J11); a worker that is really gone makes `sendMessage` reject at once.
 */
const ANSWER_TIMEOUT_MS = 120_000;
const MAX_COUNT = 10_000_000;
const MAX_TEXT = 500;

const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_COUNT));

/** `detail` of a `no-capacity` refusal (P2-26): which limit, what the pack needs, what is left. */
const CapacityDetailSchema = v.strictObject({
  reason: v.picklist(['ruleset-slots', 'regex-pool', 'rule-pool', 'registrations', 'patterns']),
  needed: count,
  available: count,
});
export type CapacityDetail = v.InferOutput<typeof CapacityDetailSchema>;

type PageErrorCode = 'invalid-request' | 'no-answer' | 'invalid-answer' | 'refused';

export interface PageError {
  readonly code: PageErrorCode;
  /** The worker's error code when it refused (`no-capacity`, `invalid-payload`, …). */
  readonly reason?: string;
  readonly detail?: CapacityDetail;
}

export type PageResult<D> = { readonly ok: true; readonly data: D } | { readonly ok: false; readonly error: PageError };

/** What the client needs from the page: `runtime.sendMessage`. */
export interface Transport {
  send(envelope: unknown): Promise<unknown>;
}

const ErrorAnswerSchema = v.object({
  ok: v.literal(false),
  error: v.object({
    code: v.pipe(v.string(), v.maxLength(MAX_TEXT)),
    message: v.pipe(v.string(), v.maxLength(MAX_TEXT)),
    detail: v.optional(v.unknown()),
  }),
});

const randomBytes = (): Uint8Array => crypto.getRandomValues(new Uint8Array(ID_BYTES));
const messageId = (random: () => Uint8Array): string => Array.from(random(), (b) => b.toString(16).padStart(2, '0')).join('');
const fail = (error: PageError): PageResult<never> => ({ ok: false, error });

function refusalOf(answer: unknown): PageError | null {
  const parsed = v.safeParse(ErrorAnswerSchema, answer);
  if (!parsed.success) return null;
  const detail = v.safeParse(CapacityDetailSchema, parsed.output.error.detail);
  return { code: 'refused', reason: parsed.output.error.code, ...(detail.success ? { detail: detail.output } : {}) };
}

function readAnswer<S extends v.GenericSchema>(answer: unknown, data: S): PageResult<v.InferOutput<S>> {
  const refusal = refusalOf(answer);
  if (refusal !== null) return fail(refusal);
  const parsed = v.safeParse(v.object({ ok: v.literal(true), data }), answer);
  return parsed.success ? { ok: true, data: parsed.output.data } : fail({ code: 'invalid-answer' });
}

/** Sends one message type with its payload and validates the answer's `data` with `schema`. */
export type Request = <T extends MessageType, S extends v.GenericSchema>(type: T, payload: PayloadOf<T>, schema: S) => Promise<PageResult<v.InferOutput<S>>>;

/** Any successful command answer; commands are re-read through the dashboard query afterwards. */
export const AnySchema = v.unknown();

export function createRequest(transport: Transport, random: () => Uint8Array = randomBytes, timeoutMs = ANSWER_TIMEOUT_MS): Request {
  return async (type, payload, schema) => {
    if (!v.safeParse(PAYLOAD_SCHEMAS[type], payload).success) return fail({ code: 'invalid-request' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    try {
      const answer = await Promise.race([transport.send({ v: ENVELOPE_VERSION, type, id: messageId(random), payload }), timeout]);
      return readAnswer(answer, schema);
    } catch {
      return fail({ code: 'no-answer' });
    } finally {
      clearTimeout(timer);
    }
  };
}
