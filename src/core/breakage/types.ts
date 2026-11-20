/**
 * Types of the breakage flow (P2-13, UI notes §6). The flow's state is a plain versioned object kept
 * in `storage.session` under the tab (P2-14 writes it); transitions return the new state and the
 * effects the panel and worker carry out. Decisions: design review, P2-13 notes.
 */
import type { Hostname } from '../ids.js';
import type { EpochMs, Level } from '../state/types.js';

/** What the user says is wrong (UI notes §6; the fourth, "an ad opened in a new tab or window", P2-62). */
export type Complaint = 'broken' | 'adThrough' | 'antiAdblock' | 'popupOpened';

/** One rung of a ladder. Report is not a remedy: it is reachable from every step and ends a ladder. */
export type Remedy = 'allowPopups' | 'light' | 'off' | 'reload' | 'picker' | 'thorough' | 'pause' | 'strictPopups';

/** Whether trying a remedy would change anything here; anything but `available` is skipped. */
export type Availability = 'available' | 'noop' | 'capped-by-parent' | 'needs-site-access' | 'needs-guard';

/** A settings change on one host. `null` values mean "not set" (inherit, default policy, no pause). */
export type Change =
  | { readonly kind: 'siteLevel'; readonly host: Hostname; readonly level: Level | 'inherit' }
  | { readonly kind: 'popupPolicy'; readonly host: Hostname; readonly policy: 'allow' | 'strict' | null }
  | { readonly kind: 'pause'; readonly host: Hostname; readonly until: EpochMs | null };

/** The host's own stored values, read by the caller just before a transition. */
export interface SiteSnapshot {
  readonly ownLevel: Level | null;
  readonly popupPolicy: 'allow' | 'strict' | null;
  readonly pausedUntil: EpochMs | null;
}

/** A remedy being tried. Reload and the picker have no settings change and no inverse. */
export interface Trial {
  readonly remedy: Remedy;
  readonly applied: Change | null;
  readonly previous: Change | null;
}

export interface Outcome {
  readonly remedy: Remedy;
  readonly result: 'still-broken' | 'skipped';
  /** Why a step was skipped. */
  readonly reason?: Exclude<Availability, 'available'>;
  /** Whether the failed trial was undone, or left because the setting had changed since. */
  readonly revert?: 'reverted' | 'revert-skipped';
}

type Phase = 'offer' | 'await' | 'report';

export interface FlowState {
  readonly v: 1;
  readonly tabId: number;
  readonly host: Hostname;
  readonly complaint: Complaint;
  /** Index into the complaint's ladder. */
  readonly step: number;
  readonly phase: Phase;
  readonly trial: Trial | null;
  readonly outcomes: readonly Outcome[];
  /** Time of the last transition; the TTL counts from here. */
  readonly updatedAt: EpochMs;
}

interface ReportSummary {
  readonly complaint: Complaint;
  readonly host: Hostname;
  readonly outcomes: readonly Outcome[];
  readonly fixedBy: Remedy | null;
}

export type Effect =
  | { readonly type: 'apply'; readonly change: Change }
  | { readonly type: 'reload' }
  | { readonly type: 'openPicker' }
  | { readonly type: 'openReport'; readonly summary: ReportSummary }
  | { readonly type: 'clearState' };

export interface Transition {
  readonly state: FlowState;
  readonly effects: readonly Effect[];
}

export interface StartContext {
  readonly tabId: number;
  readonly host: Hostname;
  /** The pop-up guard blocked something on this page: "page broken" starts with "Allow pop-ups". */
  readonly popupBlocked: boolean;
  /** Missing entries count as `available`. */
  readonly availability: Readonly<Partial<Record<Remedy, Availability>>>;
  readonly now: EpochMs;
}
