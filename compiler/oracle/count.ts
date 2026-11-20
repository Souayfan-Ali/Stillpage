/**
 * Count oracle (filter-pipeline notes §11 check 1, P1-31): per ruleset, our rule and regex counts against uBOL's
 * `ruleset-details.json` for the nearest uBOL release, like-for-like — our `main_frame`-only rules are
 * left out (uBOL counts `$doc` filters in its `strictblock` artefact) and regex are compared with the
 * uBOL regexes Chromium accepts. Outside the tolerance → warning; outside twice the tolerance → failure.
 * `popups` has no uBOL DNR counterpart: its pop-up filter counts per source list are compared instead.
 */
import { z } from 'zod';
import type { DnrRule } from '../dnr/schema.js';

const Count = z.number().int().min(0);

export const OracleFileSchema = z.strictObject({
  schema: z.literal(1),
  /** uBOL release the numbers come from. */
  ubol: z.string().min(1),
  /** Chromium build that judged uBOL's regexes. */
  chromium: z.string().min(1),
  rulesets: z.record(z.string(), z.strictObject({ ubolId: z.string().min(1), rules: Count, regex: Count, regexValid: Count })),
  /** uBOL's `popups` figure per source ruleset. */
  popups: z.record(z.string(), Count),
});
export type OracleFile = z.infer<typeof OracleFileSchema>;

export interface Tolerance {
  /** Lowest accepted relative change of the rule count (−0.15 = −15 %). */
  readonly rulesMin: number;
  /** Highest accepted relative change of the rule count. */
  readonly rulesMax: number;
  /** Highest accepted relative change of the regex count. */
  readonly regexMax: number;
  /** A failure is `failFactor` times outside the tolerance. */
  readonly failFactor: number;
}

export interface OracleRow {
  readonly what: string;
  readonly ours: number;
  readonly theirs: number;
  readonly change: number;
  readonly verdict: 'ok' | 'warn' | 'fail';
}

const isMainFrameOnly = (r: DnrRule): boolean => r.condition.resourceTypes?.length === 1 && r.condition.resourceTypes[0] === 'main_frame';

/** Like-for-like counts of one ruleset pair (safe + `-x`). */
export function likeForLike(rules: readonly DnrRule[]): { rules: number; regex: number } {
  const kept = rules.filter((r) => !isMainFrameOnly(r));
  return { rules: kept.length, regex: kept.filter((r) => r.condition.regexFilter !== undefined).length };
}

function judge(what: string, ours: number, theirs: number, min: number, max: number, factor: number): OracleRow {
  const change = theirs === 0 ? (ours === 0 ? 0 : Number.POSITIVE_INFINITY) : (ours - theirs) / theirs;
  const inside = (k: number): boolean => change >= min * k && change <= max * k;
  const verdict = inside(1) ? 'ok' : inside(factor) ? 'warn' : 'fail';
  return { what, ours, theirs, change, verdict };
}

/** Small absolute counts (uBOL's `urlhaus` is 1 rule) are judged by difference, not ratio. */
const SMALL = 20;

/** One row per ruleset (rules and regex) and per pop-up source. */
export function countOracle(oracle: OracleFile, ours: ReadonlyMap<string, readonly DnrRule[]>, popupFilters: ReadonlyMap<string, number>,
  t: Tolerance): readonly OracleRow[] {
  const rows = Object.entries(oracle.rulesets).flatMap(([id, o]) => {
    const c = likeForLike(ours.get(id) ?? []);
    const rules = o.rules < SMALL && Math.abs(c.rules - o.rules) <= SMALL ? { what: `${id} rules`, ours: c.rules, theirs: o.rules, change: 0, verdict: 'ok' as const }
      : judge(`${id} rules`, c.rules, o.rules, t.rulesMin, t.rulesMax, t.failFactor);
    const regex = o.regexValid < SMALL && Math.abs(c.regex - o.regexValid) <= SMALL ? { what: `${id} regex`, ours: c.regex, theirs: o.regexValid, change: 0, verdict: 'ok' as const }
      : judge(`${id} regex`, c.regex, o.regexValid, -1, t.regexMax, t.failFactor);
    return [rules, regex];
  });
  const popups = Object.entries(oracle.popups).map(([id, n]) => judge(`popups from ${id}`, popupFilters.get(id) ?? 0, n, t.rulesMin, t.rulesMax, t.failFactor));
  return [...rows, ...popups];
}
