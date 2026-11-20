/** "Step n of m" for the breakage flow (P2-14). Report counts as the last step. Pure. */
import { LADDERS } from '../../../core/breakage/ladders.js';
import type { FlowState } from '../../../core/breakage/types.js';

/**
 * "Page broken" starts with "Allow pop-ups" only when the guard blocked something (P2-13); otherwise
 * that rung is not shown and not counted.
 */
function offsetOf(state: FlowState): number {
  if (state.complaint !== 'broken') return 0;
  const usedPopups = state.outcomes.some((o) => o.remedy === 'allowPopups') || state.trial?.remedy === 'allowPopups';
  return usedPopups || state.step === 0 ? 0 : 1;
}

export function stepOf(state: FlowState): { readonly n: number; readonly of: number } {
  const offset = offsetOf(state);
  const of = LADDERS[state.complaint].length - offset + 1;
  return { n: state.phase === 'report' ? of : state.step - offset + 1, of };
}
