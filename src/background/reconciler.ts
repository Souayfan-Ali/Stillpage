/**
 * The reconciler (P1-11, architecture notes §5.1, ADR-012): settings × grants × catalog → desired; diff against
 * what Chrome reports; apply in the fixed order. Idempotent: a run that dies part-way is repaired by
 * the next one, which recomputes everything from the vault and the package. Runs are serialised;
 * requests that arrive during a run collapse into one extra run. A `storage.session` flag marks a
 * run in progress, so a worker that died mid-run reconciles again on its next wake. A failed startup,
 * install or update run sets one one-shot retry alarm (D-83); any run that succeeds clears it.
 */
import { nextPauseExpiry } from '../core/levels/resolve.js';
import { computeDesired, DEFAULT_DESIRED_LIMITS } from '../core/reconcile/computeDesired.js';
import { diff, isEmptyPlan } from '../core/reconcile/diff.js';
import type { ActualState } from '../core/reconcile/plan.js';
import type { PopupInputs } from '../core/reconcile/popups.js';
import type { DnrRule, SkippedPack } from '../core/reconcile/types.js';
import type { Hostname } from '../core/ids.js';
import type { DisabledRules, Ports } from '../platform/ports.js';
import { applyInOrder, hostAccessIds, staticRuleChanges } from './applyPlan.js';
import { createSettingsStore, type SettingsStore } from './settingsStore.js';

export const PENDING_KEY = 'reconcile.pending';
export const PAUSE_ALARM = 'pause-expiry';
/** One-shot retry of a failed lifecycle run (D-83, ADR-020); its run's reason is this name. */
export const RETRY_ALARM = 'reconcile-retry';
/** Chrome's floor for an alarm delay; never periodic. */
const RETRY_DELAY_MS = 30_000;
const RETRIED_REASONS: ReadonlySet<string> = new Set(['startup', 'installed:install', 'installed:update']);
/** Last outcome, for diagnostics and the update-window measurement (E2E J13). Trusted contexts only. */
export const LAST_KEY = 'reconcile.last';
const MAX_RECORDED_ERRORS = 3;

interface ReconcileOutcome {
  readonly status: 'applied' | 'unchanged' | 'failed';
  /** Registrations Chrome refused and this run dropped (logged); a warning, not a failure. */
  readonly dropped?: readonly string[];
  /** Epoch ms at which the scriptlet registrations were in, when this run registered any. */
  readonly scriptletsAt?: number;
  readonly errors: readonly string[];
  readonly skippedPacks: readonly SkippedPack[];
}

export interface ReconcilerOptions {
  /**
   * Static rule ids to keep disabled. Empty in v1; the P3 developer panel fills it from settings.
   * Chrome resets them on every update (S-07), so step (4) re-applies them.
   */
  readonly disabledRules?: readonly DisabledRules[];
  /** Pop-up lists and wiring (P2-54), read on every run; absent: no pop-up realm, no guard. */
  readonly popups?: () => Promise<PopupInputs>;
  /** User filter hosts and the session rules to keep (P2-20, P2-55), given the actual session rules. */
  readonly user?: (sessionRules: readonly DnrRule[]) => Promise<{ readonly userFilterHosts: readonly Hostname[]; readonly sessionRules: readonly DnrRule[] }>;
}

/** What `requestEarly` answers: the outcome, or `applying` once the run's DNR rules are in (D-25). */
export type EarlyOutcome = ReconcileOutcome | { readonly status: 'applying'; readonly errors: readonly string[]; readonly skippedPacks: readonly SkippedPack[] };

export interface Reconciler {
  request(reason: string): Promise<ReconcileOutcome>;
  /**
   * Like `request`, but resolves as soon as the serving run's dynamic and session rules are applied
   * (a site-level change, D-25); the run goes on with the registrations. Resolves with the final
   * outcome when the run ends first (nothing to apply, or a failure before the rules).
   */
  requestEarly(reason: string): Promise<EarlyOutcome>;
  /** Runs once when the previous worker died during a run; otherwise resolves `null`. */
  resumeIfInterrupted(): Promise<ReconcileOutcome | null>;
}

async function readActual(ports: Ports): Promise<ActualState> {
  const [enabledRulesets, dynamicRules, sessionRules, contentScripts] = await Promise.all([
    ports.dnr.getEnabledRulesets(),
    ports.dnr.getDynamicRules(),
    ports.dnr.getSessionRules(),
    ports.scripting.getRegisteredContentScripts(),
  ]);
  return { enabledRulesets, dynamicRules, sessionRules, contentScripts };
}

/** `getAvailableStaticRuleCount()`, or `null` when it cannot be read (no capacity check then; P2-26). */
export async function readCapacity(ports: Ports): Promise<number | null> {
  try {
    return await ports.dnr.getAvailableStaticRuleCount();
  } catch (error) {
    ports.log.warn('static rule count unreadable; no capacity check this run', error);
    return null;
  }
}

async function readDisabled(ports: Ports, wanted: readonly DisabledRules[]): Promise<readonly DisabledRules[]> {
  return Promise.all(wanted.map(async (w) => ({ rulesetId: w.rulesetId, ruleIds: await ports.dnr.getDisabledRuleIds(w.rulesetId) })));
}

async function schedulePauseAlarm(ports: Ports, expiry: number | null): Promise<void> {
  await (expiry === null ? ports.alarms.clear(PAUSE_ALARM) : ports.alarms.setAt(PAUSE_ALARM, expiry));
}

async function runOnce(ports: Ports, options: ReconcilerOptions, store: SettingsStore, onRulesApplied: () => void): Promise<ReconcileOutcome> {
  const now = ports.now();
  const milestones: { scriptletsAt?: number } = {};
  const dropped: string[] = [];
  const [catalog, loaded, grants, actual, disabled, available, popups] = await Promise.all([
    ports.catalog.read(),
    store.read(now),
    ports.permissions.getGrants(),
    readActual(ports),
    readDisabled(ports, options.disabledRules ?? []),
    readCapacity(ports),
    options.popups?.(),
  ]);
  // Fail closed like a missing catalog: placeholder settings must not tear down the user's state.
  if (loaded.isUnreadable) throw new Error('vault unreadable');
  const user = await options.user?.(actual.sessionRules);
  const context = {
    ...(user ?? {}),
    ...(available === null ? {} : { capacity: { available, enabled: actual.enabledRulesets } }),
    ...(popups === undefined ? {} : { popups }),
  };
  const desired = computeDesired(loaded.settings, grants, catalog, now, DEFAULT_DESIRED_LIMITS, context);
  const plan = diff(desired, actual);
  const staticRules = staticRuleChanges(options.disabledRules ?? [], disabled);
  const unchanged = isEmptyPlan(plan) && staticRules.length === 0;
  const errors = unchanged
    ? []
    : await applyInOrder(
        {
          plan,
          catalog,
          hasAllSitesAccess: desired.hasAllSitesAccess,
          hostAccessRuleIds: { dynamic: hostAccessIds(actual.dynamicRules), session: hostAccessIds(actual.sessionRules) },
          staticRules,
          onScriptletsRegistered: () => {
            milestones.scriptletsAt = ports.now();
          },
          onDropped: (detail) => {
            dropped.push(detail);
          },
          onRulesApplied,
        },
        ports,
      );
  const alarmErrors = await schedulePauseAlarm(ports, nextPauseExpiry(loaded.settings, now)).then(
    () => [],
    (error: unknown) => [`pause alarm: ${error instanceof Error ? error.message : String(error)}`],
  );
  const allErrors = [...errors, ...alarmErrors];
  const status = allErrors.length > 0 ? 'failed' : unchanged ? 'unchanged' : 'applied';
  return { status, errors: allErrors, skippedPacks: desired.skippedPacks, ...milestones, ...(dropped.length > 0 ? { dropped } : {}) };
}

async function recordLast(ports: Ports, reason: string, started: number, outcome: ReconcileOutcome): Promise<void> {
  const at = ports.now();
  const errors = outcome.errors.slice(0, MAX_RECORDED_ERRORS);
  const scriptlets = outcome.scriptletsAt === undefined ? {} : { scriptletsMs: outcome.scriptletsAt - started };
  const dropped = outcome.dropped === undefined ? {} : { dropped: outcome.dropped.slice(0, MAX_RECORDED_ERRORS) };
  await ports.session.set(LAST_KEY, { reason, status: outcome.status, at, durationMs: at - started, errors, ...scriptlets, ...dropped });
}

/** Sets the retry after a failed lifecycle run, clears it after any success; the retry run itself never re-arms it. */
async function settleRetry(ports: Ports, reason: string, failed: boolean): Promise<void> {
  if (failed && !RETRIED_REASONS.has(reason)) return;
  try {
    await (failed ? ports.alarms.setAt(RETRY_ALARM, ports.now() + RETRY_DELAY_MS) : ports.alarms.clear(RETRY_ALARM));
  } catch (error) {
    ports.log.warn('retry alarm not updated', error);
  }
}

async function guardedRun(ports: Ports, options: ReconcilerOptions, store: SettingsStore, reason: string, onRulesApplied: () => void): Promise<ReconcileOutcome> {
  const started = ports.now();
  try {
    await ports.session.set(PENDING_KEY, true);
    const outcome = await runOnce(ports, options, store, onRulesApplied);
    if (outcome.status === 'failed') ports.log.error(`reconcile failed (${reason})`, outcome.errors);
    else await ports.session.remove(PENDING_KEY);
    await settleRetry(ports, reason, outcome.status === 'failed');
    await recordLast(ports, reason, started, outcome);
    return outcome;
  } catch (error) {
    ports.log.error(`reconcile failed (${reason})`, error);
    const outcome: ReconcileOutcome = { status: 'failed', errors: [error instanceof Error ? error.message : String(error)], skippedPacks: [] };
    await settleRetry(ports, reason, true);
    await recordLast(ports, reason, started, outcome).catch((recordError: unknown) => {
      ports.log.warn('last reconcile run not recorded', recordError);
    });
    return outcome;
  }
}

/**
 * One store per worker wake, so every settings write shares one queue (review LOW 16): the worker
 * passes the store its command handlers write through.
 */
export function createReconciler(ports: Ports, options: ReconcilerOptions = {}, store: SettingsStore = createSettingsStore(ports.vault, ports.log)): Reconciler {
  let current: Promise<ReconcileOutcome> | null = null;
  let next: Promise<ReconcileOutcome> | null = null;
  /** Early waiters for the next run to start; a run takes them when it starts. */
  let waiting: (() => void)[] = [];

  const request = (reason: string): Promise<ReconcileOutcome> => {
    if (next) return next;
    if (!current) {
      const mine = waiting;
      waiting = [];
      current = guardedRun(ports, options, store, reason, () => {
        mine.forEach((w) => {
          w();
        });
      }).finally(() => {
        current = null;
      });
      return current;
    }
    next = current.then(() => {
      next = null;
      return request(reason);
    });
    return next;
  };

  const requestEarly = (reason: string): Promise<EarlyOutcome> =>
    new Promise((resolve) => {
      waiting.push(() => {
        resolve({ status: 'applying', errors: [], skippedPacks: [] });
      });
      void request(reason).then(resolve);
    });

  return {
    request,
    requestEarly,
    // A wake's own trigger usually already runs; resume only when nothing is in flight (review LOW 15).
    resumeIfInterrupted: async () => (current === null && (await ports.session.get(PENDING_KEY)) === true ? request('resume') : null),
  };
}
