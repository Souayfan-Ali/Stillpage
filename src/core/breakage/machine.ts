/**
 * The breakage flow as a pure state machine (P2-13, UI notes §6; decisions: design review, P2-13 notes).
 *
 * - Trying a remedy applies it as an ordinary settings change and records its inverse.
 * - "Still broken" undoes the trial (compare-and-revert: only while the setting still holds what
 *   the trial applied) and offers the next untried option, so Off is tried from the original level.
 * - "Fixed" keeps the change and ends the flow; a pause simply runs out.
 * - Cancel undoes a pending trial; a trial nobody answered stays applied (see `readFlow`).
 * - Remedies that would change nothing are skipped and recorded with their reason.
 * Every function returns new objects; the caller carries out the effects.
 */
import type { EpochMs } from '../state/types.js';
import { changeOf, currentOf, LADDERS, sameChange } from './ladders.js';
import type { Availability, Complaint, Effect, FlowState, Outcome, Remedy, SiteSnapshot, StartContext, Transition, Trial } from './types.js';

type AvailabilityMap = Readonly<Partial<Record<Remedy, Availability>>>;

/** A transition that ends the flow: the stored state is deleted (`clearState`). */
export interface EndTransition {
  readonly state: null;
  readonly effects: readonly Effect[];
  readonly fixedBy?: Remedy | null;
}

/** Moves to the first step with an untried, available option, recording skips; Report past the end. */
function settle(state: FlowState, availability: AvailabilityMap): FlowState {
  const ladder = LADDERS[state.complaint];
  let outcomes = state.outcomes;
  for (let step = state.step; step < ladder.length; step += 1) {
    const done = new Set(outcomes.map((o) => o.remedy));
    const fresh = (ladder[step] ?? []).filter((r) => !done.has(r));
    const skipped = fresh.flatMap((remedy): Outcome[] => {
      const reason = availability[remedy] ?? 'available';
      return reason === 'available' ? [] : [{ remedy, result: 'skipped', reason }];
    });
    outcomes = [...outcomes, ...skipped];
    if (fresh.length > skipped.length) return { ...state, step, outcomes, phase: 'offer', trial: null };
  }
  return { ...state, step: ladder.length - 1, outcomes, phase: 'report', trial: null };
}

/** Starts a ladder. Without a blocked pop-up, "page broken" skips its pop-up step silently. */
export function startFlow(complaint: Complaint, ctx: StartContext): Transition {
  const firstStep = complaint === 'broken' && !ctx.popupBlocked ? 1 : 0;
  const initial: FlowState = { v: 1, tabId: ctx.tabId, host: ctx.host, complaint, step: firstStep, phase: 'offer', trial: null, outcomes: [], updatedAt: ctx.now };
  return { state: settle(initial, ctx.availability), effects: [] };
}

/** Options the panel offers now. */
export function offeredRemedies(state: FlowState): readonly Remedy[] {
  if (state.phase !== 'offer') return [];
  const done = new Set(state.outcomes.map((o) => o.remedy));
  return (LADDERS[state.complaint][state.step] ?? []).filter((r) => !done.has(r));
}

function trialEffects(trial: Trial): readonly Effect[] {
  if (trial.applied !== null) return [{ type: 'apply', change: trial.applied }, { type: 'reload' }];
  return trial.remedy === 'reload' ? [{ type: 'reload' }] : [{ type: 'openPicker' }];
}

/** "Try it": applies `remedy` when the current step offers it; otherwise nothing happens. */
export function tryRemedy(state: FlowState, remedy: Remedy, snapshot: SiteSnapshot, now: EpochMs): Transition {
  if (!offeredRemedies(state).includes(remedy)) return { state, effects: [] };
  const applied = changeOf(remedy, state.host, now);
  const trial: Trial = { remedy, applied, previous: applied === null ? null : currentOf(applied, snapshot) };
  return { state: { ...state, phase: 'await', trial, updatedAt: now }, effects: trialEffects(trial) };
}

/** Undo of a trial, only while the setting still holds what the trial applied. */
function revertOf(trial: Trial, snapshot: SiteSnapshot): { readonly effects: readonly Effect[]; readonly revert?: Outcome['revert'] } {
  if (trial.applied === null || trial.previous === null) return { effects: [] };
  if (!sameChange(currentOf(trial.applied, snapshot), trial.applied)) return { effects: [], revert: 'revert-skipped' };
  return { effects: [{ type: 'apply', change: trial.previous }], revert: 'reverted' };
}

/** "Still broken": undoes the trial and offers what comes next (or Report). */
export function markStillBroken(state: FlowState, snapshot: SiteSnapshot, availability: AvailabilityMap, now: EpochMs): Transition {
  if (state.phase !== 'await' || state.trial === null) return { state, effects: [] };
  const { effects, revert } = revertOf(state.trial, snapshot);
  const outcome: Outcome = { remedy: state.trial.remedy, result: 'still-broken', ...(revert !== undefined && { revert }) };
  return { state: settle({ ...state, outcomes: [...state.outcomes, outcome], trial: null, updatedAt: now }, availability), effects };
}

/** "Fixed": keeps the change and ends the flow. */
export function markFixed(state: FlowState): EndTransition {
  return { state: null, effects: [{ type: 'clearState' }], fixedBy: state.trial?.remedy ?? null };
}

/** Cancel (or choosing another complaint): undoes a pending trial and ends the flow. */
export function cancelFlow(state: FlowState, snapshot: SiteSnapshot): EndTransition {
  const undo = state.trial === null ? [] : revertOf(state.trial, snapshot).effects;
  return { state: null, effects: [...undo, { type: 'clearState' }] };
}

/** "Report this": reachable from every step; a pending trial stays as it is. */
export function openReport(state: FlowState, now: EpochMs): Transition {
  const summary = { complaint: state.complaint, host: state.host, outcomes: state.outcomes, fixedBy: null };
  return { state: { ...state, phase: 'report', updatedAt: now }, effects: [{ type: 'openReport', summary }] };
}
