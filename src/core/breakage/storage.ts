/**
 * Reading the breakage flow back from `storage.session` (P2-13: the state survives the reload).
 * The stored value is untrusted input: it is validated in full, bound to its tab and host, and
 * dropped after `FLOW_TTL_MS` without a transition (design review, P2-13 notes).
 */
import * as v from 'valibot';
import type { Hostname } from '../ids.js';
import { parseHostname } from '../hostname/validate.js';
import { LEVELS, type EpochMs } from '../state/types.js';
import { LADDERS } from './ladders.js';
import type { FlowState, Trial } from './types.js';

/** A flow untouched this long is discarded (counted from its last transition). */
export const FLOW_TTL_MS = 30 * 60_000;

/** `storage.session` key of a tab's flow. */
export const flowKey = (tabId: number): string => `breakage:${String(tabId)}`;

const Host = v.pipe(v.string(), v.check((h) => parseHostname(h) === h, 'invalid hostname'), v.transform((h) => h as Hostname));
const Epoch = v.pipe(v.number(), v.integer(), v.minValue(0));
const RemedySchema = v.picklist(['allowPopups', 'light', 'off', 'reload', 'picker', 'thorough', 'pause', 'strictPopups']);
const ChangeSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('siteLevel'), host: Host, level: v.picklist([...LEVELS, 'inherit']) }),
  v.strictObject({ kind: v.literal('popupPolicy'), host: Host, policy: v.nullable(v.picklist(['allow', 'strict'])) }),
  v.strictObject({ kind: v.literal('pause'), host: Host, until: v.nullable(Epoch) }),
]);
const TrialSchema = v.strictObject({ remedy: RemedySchema, applied: v.nullable(ChangeSchema), previous: v.nullable(ChangeSchema) });
const OutcomeSchema = v.strictObject({
  remedy: RemedySchema,
  result: v.picklist(['still-broken', 'skipped']),
  reason: v.exactOptional(v.picklist(['noop', 'capped-by-parent', 'needs-site-access', 'needs-guard'])),
  revert: v.exactOptional(v.picklist(['reverted', 'revert-skipped'])),
});
const FlowSchema = v.strictObject({
  v: v.literal(1),
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  host: Host,
  complaint: v.picklist(['broken', 'adThrough', 'antiAdblock', 'popupOpened']),
  step: v.pipe(v.number(), v.integer(), v.minValue(0)),
  phase: v.picklist(['offer', 'await', 'report']),
  trial: v.nullable(TrialSchema),
  outcomes: v.pipe(v.array(OutcomeSchema), v.maxLength(16)),
  updatedAt: Epoch,
});

export type ReadResult =
  | { readonly kind: 'active'; readonly state: FlowState }
  /** The tab is on another host now: keep the state (a sign-in round trip comes back). */
  | { readonly kind: 'not-applicable' }
  /** Delete the stored value; `orphan` is a trial nobody answered, for a later "keep / undo". */
  | { readonly kind: 'discard'; readonly orphan: Trial | null };

const DISCARD: ReadResult = { kind: 'discard', orphan: null };

/** Cross-field checks the schema cannot express. */
function coherent(state: FlowState): boolean {
  const ladder = LADDERS[state.complaint];
  const inLadder = ladder.flat();
  const trialFits = state.trial === null ? state.phase !== 'await' : state.phase !== 'offer' && inLadder.includes(state.trial.remedy);
  return state.step < ladder.length && trialFits;
}

/** Interprets a stored value for `tabId` currently showing `host` at time `now`. */
export function readFlow(raw: unknown, tabId: number, host: Hostname, now: EpochMs): ReadResult {
  const parsed = v.safeParse(FlowSchema, raw);
  if (!parsed.success) return DISCARD;
  const state: FlowState = parsed.output;
  if (state.tabId !== tabId || state.updatedAt > now || !coherent(state)) return DISCARD;
  if (now - state.updatedAt > FLOW_TTL_MS) return { kind: 'discard', orphan: state.trial };
  return state.host === host ? { kind: 'active', state } : { kind: 'not-applicable' };
}
