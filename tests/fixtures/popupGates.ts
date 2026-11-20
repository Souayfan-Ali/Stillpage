/**
 * The pop-up gates of performance notes §5 and pop-up notes §14 (P2-61), over the verdicts the journeys observed:
 * Smart block rate ≥ 90 % on the 14 guard-alone pages, Strict blocks all of them but P8b, no must-pass
 * row blocked, and no worker wake-up (boot counter, S-22). Pure, so the gates are unit-tested on
 * synthetic tables before the guard exists.
 */
import { GUARD_ALONE, type PopupRow, type PopupVerdict } from './popupManifest.js';

const SMART_MIN_BLOCK_RATE = 0.9;

export interface Observed {
  readonly row: PopupRow;
  readonly verdict: PopupVerdict;
}

export type Mode = 'guardOff' | 'smart' | 'strict';

export interface Gate {
  readonly pass: boolean;
  readonly failures: readonly string[];
}

const guardAlone = (observed: readonly Observed[]): readonly Observed[] => observed.filter((o) => o.row.guardAlone === true);

/** Smart: blocked share of the guard-alone pages; fails if any of the 14 is missing from the run. */
export function smartGate(observed: readonly Observed[]): { pass: boolean; blocked: number; total: number; rate: number; missed: readonly string[] } {
  const set = guardAlone(observed);
  const blocked = set.filter((o) => o.verdict === 'blocked').length;
  const total = set.length;
  const rate = total === 0 ? 0 : blocked / total;
  const missed = set.filter((o) => o.verdict !== 'blocked').map((o) => o.row.id);
  return { pass: total === GUARD_ALONE.length && rate >= SMART_MIN_BLOCK_RATE, blocked, total, rate, missed };
}

/** Strict: every guard-alone page whose row expects a Strict block is blocked (all but P8b). */
export function strictGate(observed: readonly Observed[]): Gate {
  const failures = guardAlone(observed)
    .filter((o) => o.row.expect.strict === 'blocked' && o.verdict !== 'blocked')
    .map((o) => o.row.id);
  return { pass: failures.length === 0, failures };
}

/** Must-pass: no `popups-allow/` row that expects `opened` in `mode` was blocked. */
export function mustPassGate(observed: readonly Observed[], mode: Mode): Gate {
  const failures = observed
    .filter((o) => o.row.family === 'popups-allow' && o.row.expect[mode] === 'opened' && o.verdict === 'blocked')
    .map((o) => o.row.id);
  return { pass: failures.length === 0, failures };
}

/** Worker boots between two readings of the counter; any is a failure (performance notes §2.2). */
export function wakeGate(before: number, after: number): { pass: boolean; wakes: number } {
  const wakes = after - before;
  return { pass: wakes === 0, wakes };
}

/**
 * Files whose arrival retires a pending marker. A pending reason names the file it waits for
 * (`blocked.html`, `popup-sentinel`, `popup-shim`, `notify-gate`); a row still pending while the build
 * ships that file is a stale marker and fails J17, so a skip cannot outlive its feature. A reason that
 * waits for a piece inside a shipped file (e.g. the blocked page's Proceed once handler) names none.
 */
const ARTEFACTS: readonly { readonly named: string; readonly file: RegExp }[] = [
  { named: 'blocked.html', file: /(?:^|\/)blocked\.html$/ },
  { named: 'popup-sentinel', file: /popup-sentinel/ },
  { named: 'popup-shim', file: /popup-shim/ },
  { named: 'notify-gate', file: /notify-gate/ },
];

export function staleMarkers(rows: readonly PopupRow[], shippedFiles: readonly string[]): readonly string[] {
  const shipped = ARTEFACTS.filter((a) => shippedFiles.some((f) => a.file.test(f)));
  return rows.filter((r) => r.pending !== undefined && shipped.some((a) => r.pending?.includes(a.named) === true)).map((r) => r.id);
}

/** Rows whose verdict differs from the row's expectation in `mode`; `miss` accepts either verdict. */
export function expectationFailures(observed: readonly Observed[], mode: Mode): readonly { id: string; wanted: string; actual: PopupVerdict }[] {
  return observed
    .map((o) => ({ id: o.row.id, wanted: o.row.expect[mode] ?? 'none', actual: o.verdict }))
    .filter((r) => r.wanted !== 'miss' && r.wanted !== r.actual);
}
