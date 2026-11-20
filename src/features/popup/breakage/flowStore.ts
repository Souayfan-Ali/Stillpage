/**
 * The breakage flow in the toolbar panel (P2-14, UI notes §6) around the pure machine of P2-13.
 *
 * - The flow's state lives in `storage.session` under `breakage:<tabId>`, bound to the host. The next
 *   state is written **before** any effect runs, because the panel can close at any moment (the reload
 *   closes it); every step resumes from the stored state when the panel opens again (design review, P2-14).
 * - Settings changes go through the worker's site commands; their answers carry the stored values,
 *   so a pause trial records the `until` the worker actually stored and "Still broken" can undo it.
 * - A trial nobody answered before the flow expired is offered as "Keep the change / Undo it".
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import { cancelFlow, markFixed, markStillBroken, openReport, startFlow, tryRemedy } from '../../../core/breakage/machine.js';
import { currentOf, sameChange } from '../../../core/breakage/ladders.js';
import { flowKey, readFlow } from '../../../core/breakage/storage.js';
import type { Complaint, Effect, FlowState, Remedy, Trial } from '../../../core/breakage/types.js';
import type { Hostname } from '../../../core/ids.js';
import type { TabState } from '../../../core/messaging/tabState.js';
import type { PopupLog } from '../../../core/popup/log.js';
import type { SiteSnapshot } from '../../../core/state/site.js';
import type { Client } from '../client.js';
import { availabilityOf, runEffects, siteOf, type RunResult } from './effects.js';
import { FLOW_STRINGS } from './strings.js';

type FlowView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'choose' }
  | { readonly kind: 'active'; readonly state: FlowState }
  | { readonly kind: 'orphan'; readonly trial: Trial }
  | { readonly kind: 'fixed'; readonly remedy: Remedy | null };

export interface FlowDeps {
  readonly client: Pick<Client, 'tabState' | 'siteCommand' | 'command'>;
  readonly session: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> };
  readonly reloadTab: (tabId: number) => Promise<void>;
  readonly now: () => number;
  readonly tabId: number;
  readonly host: Hostname;
  /** The page's pop-up log (P2-62); `null` when the page has no sentinel. */
  readonly popupLog?: () => Promise<PopupLog | null>;
}

export interface FlowStore {
  readonly view: ReadonlySignal<FlowView>;
  /** Result of the last step, for a `role="status"` line. */
  readonly status: ReadonlySignal<string>;
  load(): Promise<void>;
  start(complaint: Complaint): Promise<void>;
  tryIt(remedy: Remedy): Promise<void>;
  stillBroken(): Promise<void>;
  fixed(): Promise<void>;
  cancel(): Promise<void>;
  report(): Promise<void>;
  keepOrphan(): Promise<void>;
  undoOrphan(): Promise<void>;
}

/** The trial with the stored `until` of a pause, once the worker has answered. */
function withStoredUntil(state: FlowState, site: SiteSnapshot): FlowState {
  const applied = state.trial?.applied;
  if (state.trial === null || applied?.kind !== 'pause' || site.pausedUntil === null) return state;
  return { ...state, trial: { ...state.trial, applied: { ...applied, until: site.pausedUntil } } };
}

const hasChange = (trial: Trial | null | undefined): trial is Trial => trial !== null && trial !== undefined && trial.applied !== null;

/** An orphan is offered only for the host the panel shows (security review MEDIUM: a TTL-expired flow of another host). */
const orphanFor = (trial: Trial | null, host: Hostname): Trial | null =>
  hasChange(trial) && trial.applied?.host === host && (trial.previous === null || trial.previous.host === host) ? trial : null;

export function createFlowStore(deps: FlowDeps): FlowStore {
  const view = signal<FlowView>({ kind: 'loading' });
  const status = signal('');
  const key = flowKey(deps.tabId);
  let busy = false;

  /** The tab's current state, read fresh before each transition. */
  const current = async (): Promise<TabState | null> => {
    const result = await deps.client.tabState(deps.tabId);
    return result.ok && result.data.host === deps.host ? result.data : null;
  };

  const save = async (state: FlowState | null): Promise<boolean> => {
    try {
      await (state === null ? deps.session.remove(key) : deps.session.set(key, state));
      return true;
    } catch {
      status.value = FLOW_STRINGS.saveFailed;
      return false;
    }
  };

  const run = (effects: readonly Effect[]): Promise<RunResult> =>
    runEffects(deps, effects, (text) => {
      status.value = text;
    });

  /** One transition at a time; a second click while one runs is ignored. */
  const step = async (task: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    status.value = '';
    try {
      await task();
    } finally {
      busy = false;
    }
  };

  const active = (): FlowState | null => (view.value.kind === 'active' ? view.value.state : null);

  const load = async (): Promise<void> => {
    let raw: unknown;
    try {
      raw = await deps.session.get(key);
    } catch {
      // Unreadable is not absent: keep whatever is stored (a pending trial) and say the state is unknown.
      view.value = { kind: 'choose' };
      status.value = FLOW_STRINGS.stateFailed;
      return;
    }
    const read = readFlow(raw, deps.tabId, deps.host, deps.now());
    if (read.kind === 'active') view.value = { kind: 'active', state: read.state };
    const orphan = read.kind === 'discard' ? orphanFor(read.orphan, deps.host) : null;
    if (read.kind === 'active') return;
    view.value = orphan === null ? { kind: 'choose' } : { kind: 'orphan', trial: orphan };
    if (read.kind === 'discard' && orphan === null) await save(null);
  };

  const start = (complaint: Complaint): Promise<void> =>
    step(async () => {
      const tab = await current();
      if (tab === null) {
        status.value = FLOW_STRINGS.stateFailed;
        return;
      }
      // A blocked pop-up on this page puts "Allow pop-ups on this site" first for "page broken" (P2-62).
      const log = (await deps.popupLog?.().catch(() => null)) ?? null;
      const ctx = { tabId: deps.tabId, host: deps.host, popupBlocked: (log?.blocked ?? 0) > 0, availability: availabilityOf(tab, deps.host), now: deps.now() };
      const { state } = startFlow(complaint, ctx);
      if (await save(state)) view.value = { kind: 'active', state };
    });

  const tryIt = (remedy: Remedy): Promise<void> =>
    step(async () => {
      const state = active();
      const tab = await current();
      if (state === null || tab === null) return;
      const next = tryRemedy(state, remedy, siteOf(tab), deps.now());
      if (next.effects.length === 0 || !(await save(next.state))) return;
      // The next step is shown once its effects ran, so "Fixed" / "Still broken" are never ignored.
      const result = await run(next.effects);
      if (!result.ok) {
        // Nothing was applied (review MEDIUM): stay on the offer, stored as it was.
        if (await save(state)) view.value = { kind: 'active', state };
        return;
      }
      const stored = result.site === null ? next.state : withStoredUntil(next.state, result.site);
      if (stored !== next.state) await save(stored);
      view.value = { kind: 'active', state: stored };
    });

  const stillBroken = (): Promise<void> =>
    step(async () => {
      const state = active();
      const tab = await current();
      if (state === null || tab === null) return;
      const next = markStillBroken(state, siteOf(tab), availabilityOf(tab, deps.host), deps.now());
      if (!(await save(next.state))) return;
      const outcome = next.state.outcomes.at(-1);
      await run(next.effects);
      view.value = { kind: 'active', state: next.state };
      if (outcome?.revert === 'revert-skipped') status.value = FLOW_STRINGS.revertSkipped;
    });

  /** Ends the flow once its undo (if any) went through; a failed undo keeps the flow, so nothing is lost silently. */
  const end = async (transition: { readonly effects: readonly Effect[] }, after: FlowView): Promise<void> => {
    if (!(await run(transition.effects.filter((e) => e.type !== 'clearState'))).ok) return;
    if (await save(null)) view.value = after;
  };

  const fixed = (): Promise<void> =>
    step(async () => {
      const state = active();
      if (state === null) return;
      const done = markFixed(state);
      await end(done, { kind: 'fixed', remedy: done.fixedBy ?? null });
    });

  const cancel = (): Promise<void> =>
    step(async () => {
      const state = active();
      const tab = await current();
      if (state === null) return;
      if (tab === null) {
        // Compare-and-revert needs the host's current values: keep the flow and say so (review MEDIUM).
        status.value = FLOW_STRINGS.stateFailed;
        return;
      }
      await end(cancelFlow(state, siteOf(tab)), { kind: 'choose' });
    });

  const report = (): Promise<void> =>
    step(async () => {
      const state = active();
      if (state === null) return;
      const next = openReport(state, deps.now());
      if (await save(next.state)) view.value = { kind: 'active', state: next.state };
    });

  const keepOrphan = (): Promise<void> =>
    step(async () => {
      if (await save(null)) view.value = { kind: 'choose' };
    });

  const undoOrphan = (): Promise<void> =>
    step(async () => {
      const orphan = orphanFor(view.value.kind === 'orphan' ? view.value.trial : null, deps.host);
      const tab = await current();
      if (orphan?.applied == null || orphan.previous === null || tab === null) return;
      const unchanged = sameChange(currentOf(orphan.applied, siteOf(tab)), orphan.applied);
      if (unchanged && !(await run([{ type: 'apply', change: orphan.previous }])).ok) return;
      if (!unchanged) status.value = FLOW_STRINGS.revertSkipped;
      if (await save(null)) view.value = { kind: 'choose' };
    });

  return { view, status, load, start, tryIt, stillBroken, fixed, cancel, report, keepOrphan, undoOrphan };
}
