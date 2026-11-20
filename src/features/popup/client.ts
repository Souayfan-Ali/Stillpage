/**
 * The panel's side of the P1-12 envelope (architecture notes §7): it builds `{ v: 1, type, id, payload }`, sends
 * it through the page port and validates the answer before anything is drawn from it. Payloads are
 * checked with the same schemas the worker uses, so the panel never sends what the worker would
 * refuse. Never throws: every failure is a typed `ClientError`.
 */
import * as v from 'valibot';
import { PAYLOAD_SCHEMAS, type MessageType, type PayloadOf } from '../../core/messaging/schemas.js';
import { MatchedRulesSchema, type MatchedRules } from '../../core/messaging/matched.js';
import { SiteSnapshotSchema, TabStateSchema, type TabState } from '../../core/messaging/tabState.js';
import type { SiteSnapshot } from '../../core/state/site.js';

const ENVELOPE_VERSION = 1;
const ID_BYTES = 9;
/** A worker that has not answered by then is treated as gone (it wakes in ≈ 100 ms, S-06). */
const ANSWER_TIMEOUT_MS = 5_000;

type ClientErrorCode = 'invalid-request' | 'no-answer' | 'invalid-answer' | 'not-implemented' | 'refused' | 'no-capacity';

/** `c/setPack`'s `no-capacity` detail (P2-26), validated on the page side before it is worded. */
const CapacityDetailSchema = v.strictObject({
  reason: v.picklist(['ruleset-slots', 'regex-pool', 'rule-pool', 'registrations', 'patterns']),
  needed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  available: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type CapacityDetail = v.InferOutput<typeof CapacityDetailSchema>;

interface ClientError {
  readonly code: ClientErrorCode;
  readonly message: string;
  /** Only on `no-capacity`, and only when the worker's detail is well formed. */
  readonly detail?: CapacityDetail;
}

export type ClientResult<D> = { readonly ok: true; readonly data: D } | { readonly ok: false; readonly error: ClientError };

/** What the client needs from the page port. */
export interface Transport {
  send(envelope: unknown): Promise<unknown>;
}

const ErrorAnswerSchema = v.object({
  ok: v.literal(false),
  error: v.object({ code: v.string(), message: v.string(), detail: v.optional(v.unknown()) }),
});
/** `c/setPack` answers whether the page should offer Thorough (P2-27). */
const PackDataSchema = v.object({ status: v.string(), offerThorough: v.boolean() });
const DataAnswerSchema = <S extends v.GenericSchema>(data: S) => v.object({ ok: v.literal(true), data });
/** Commands answer with a summary of the reconcile (or `c/dismissNotice`'s acknowledgement); the panel only needs to know it succeeded. */
const CommandDataSchema = v.union([v.object({ status: v.string() }), v.strictObject({ dismissed: v.literal(true) })]);
/** `c/removeUserFilter` answers with no data (P3-17: Remove in the panel). */
const commandData = (type: MessageType): v.GenericSchema => (type === 'c/removeUserFilter' ? v.null() : CommandDataSchema);
/** Site commands also answer with the host's own values as stored (P2-14 compare-and-revert). */
const SiteDataSchema = v.object({ status: v.string(), site: SiteSnapshotSchema });

type SiteCommand = 'c/setSiteLevel' | 'c/pauseSite' | 'c/setSitePopupPolicy';

const fail = (code: ClientErrorCode, message: string): ClientResult<never> => ({
  ok: false,
  error: { code, message },
});

const randomBytes = (): Uint8Array => crypto.getRandomValues(new Uint8Array(ID_BYTES));

function messageId(random: () => Uint8Array): string {
  return Array.from(random(), (b) => b.toString(16).padStart(2, '0')).join('');
}

function readAnswer<S extends v.GenericSchema>(answer: unknown, data: S): ClientResult<v.InferOutput<S>> {
  const error = v.safeParse(ErrorAnswerSchema, answer);
  if (error.success) {
    const { code, message, detail } = error.output.error;
    if (code === 'no-capacity') {
      const parsed = v.safeParse(CapacityDetailSchema, detail);
      return { ok: false, error: { code, message, ...(parsed.success ? { detail: parsed.output } : {}) } };
    }
    return fail(code === 'not-implemented' ? 'not-implemented' : 'refused', message);
  }
  const parsed = v.safeParse(DataAnswerSchema(data), answer);
  return parsed.success ? { ok: true, data: parsed.output.data } : fail('invalid-answer', 'the answer did not have the expected shape');
}

export interface Client {
  tabState(tabId: number): Promise<ClientResult<TabState>>;
  /** P2-11: what Chrome's matcher reported for the tab, per category and bucket. */
  matchedRules(tabId: number): Promise<ClientResult<MatchedRules>>;
  command<T extends Exclude<MessageType, 'q/tabState' | 'q/matchedRules' | `cs/${string}`>>(type: T, payload: PayloadOf<T>): Promise<ClientResult<null>>;
  /** `c/setPack` (settings pages): whether to offer Thorough, or a `no-capacity` error with its detail. */
  setPack(pack: string, enabled: boolean): Promise<ClientResult<{ readonly offerThorough: boolean }>>;
  /** A site command whose answer carries the host's stored values. */
  siteCommand<T extends SiteCommand>(type: T, payload: PayloadOf<T>): Promise<ClientResult<SiteSnapshot>>;
}

export function createClient(transport: Transport, random: () => Uint8Array = randomBytes, timeoutMs = ANSWER_TIMEOUT_MS): Client {
  const request = async <S extends v.GenericSchema>(type: MessageType, payload: unknown, data: S): Promise<ClientResult<v.InferOutput<S>>> => {
    if (!v.safeParse(PAYLOAD_SCHEMAS[type], payload).success) return fail('invalid-request', `invalid payload for ${type}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    try {
      const answer = await Promise.race([transport.send({ v: ENVELOPE_VERSION, type, id: messageId(random), payload }), timeout]);
      return readAnswer(answer, data);
    } catch {
      return fail('no-answer', 'the background worker did not answer');
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    tabState: (tabId) => request('q/tabState', { tabId }, TabStateSchema),
    matchedRules: (tabId) => request('q/matchedRules', { tabId }, MatchedRulesSchema),
    command: async (type, payload) => {
      const result = await request(type, payload, commandData(type));
      return result.ok ? { ok: true, data: null } : result;
    },
    setPack: async (pack, enabled) => {
      const result = await request('c/setPack', { pack, enabled }, PackDataSchema);
      return result.ok ? { ok: true, data: { offerThorough: result.data.offerThorough } } : result;
    },
    siteCommand: async (type, payload) => {
      const result = await request(type, payload, SiteDataSchema);
      return result.ok ? { ok: true, data: result.data.site } : result;
    },
  };
}
