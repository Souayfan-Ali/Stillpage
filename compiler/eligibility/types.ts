/** Inputs and verdicts of the eligibility gate E1–E11 (update-strategy notes §3.3, P2-02). */
import type { Ledger } from '../postpass/ledger.js';
import type { ReleaseRecord } from '../release/record.js';

export type CheckId = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8' | 'E9' | 'E10' | 'E11';

/** Failure action of a check (update-strategy notes §3.3, last column). */
export type GateAction = 'abort' | 'route-to-full' | 'open-pr' | 'skip';

export interface CheckResult {
  readonly id: CheckId;
  readonly pass: boolean;
  /** What a failure of this check does. */
  readonly action: GateAction;
  readonly problems: readonly string[];
}

/** Store item state as the store client reports it (P2-04 `fetchStatus`), reduced to what E1 / E11 need. */
export interface StoreState {
  readonly published: boolean;
  /** Version live in the store, if any. */
  readonly publishedVersion?: string;
  /** The item carries a policy warning or was taken down. */
  readonly warned: boolean;
  /** A submission (ours or a full release's) is waiting for review or publishing. */
  readonly pendingSubmission: boolean;
}

/** E9: the candidate loaded unpacked in Chromium, plus the DNR tables and the smoke corpus. */
export interface LoadReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface GateInput {
  readonly base: Uint8Array;
  readonly candidate: Uint8Array;
  /** Record of the currently published release (E1). */
  readonly record: ReleaseRecord;
  /** Ledgers before and after the candidate's build, by slot id (E7). */
  readonly ledgers: { readonly before: ReadonlyMap<string, Ledger>; readonly after: ReadonlyMap<string, Ledger> };
  /** `isRegexSupported` answers by `queryKey` (`dist/compiler/regex-results.json`, E8). */
  readonly regexSupported: ReadonlyMap<string, boolean>;
  /** E9 result; undefined = not run, which fails E9. */
  readonly load?: LoadReport;
  /** E11 input; undefined = unknown, which fails E11. */
  readonly store?: StoreState;
}

/** Overall outcome: `publish` only when every check passes. */
export type GateOutcome = 'publish' | GateAction;

export interface GateVerdict {
  readonly outcome: GateOutcome;
  readonly checks: readonly CheckResult[];
}

/** One check's result. */
export const result = (id: CheckId, action: GateAction, problems: readonly string[]): CheckResult =>
  ({ id, pass: problems.length === 0, action, problems });
