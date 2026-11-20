/**
 * Exit codes of `lists:build` (update-strategy notes §3.3 as amended by D-40, 2026-11-14). A failed build never writes
 * `public/`, whatever the code. Oracle-only failures get their own code so the daily workflow opens or
 * updates one PR for a human (fix the compiler, add an explained class, or refresh the oracle) instead of
 * failing silently day after day; growth keeps 3 ("review and merge").
 */
export const EXIT = { ok: 0, failure: 1, growth: 3, oracle: 4 } as const;
export const ORACLE_FAILURE_PREFIX = 'count oracle: ';

export interface Verdict {
  readonly exit: (typeof EXIT)[keyof typeof EXIT];
  readonly writeOutputs: boolean;
}

export function buildVerdict(failures: readonly string[], growth: { readonly growth: boolean; readonly failOnGrowth: boolean }): Verdict {
  if (failures.some((f) => !f.startsWith(ORACLE_FAILURE_PREFIX))) return { exit: EXIT.failure, writeOutputs: false };
  if (failures.length > 0) return { exit: EXIT.oracle, writeOutputs: false };
  return { exit: growth.growth && growth.failOnGrowth ? EXIT.growth : EXIT.ok, writeOutputs: true };
}
