/**
 * Oracle warn days (D-40): `lists:build` exits 4 when only the count oracle failed. The daily workflow
 * then opens or updates **one** oracle pull request; its body carries the dates of the warn days in a
 * hidden marker, so the streak survives between runs without a commit. Three consecutive warn days open
 * (or update) one tracking issue. A day without an oracle failure ends the streak. Pure.
 */
const MARKER = /<!-- oracle-days: (\[[^\]]{0,4000}\]) -->/;
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day (`2026-02-31` and `2026-13-45` are refused: Date would shift or throw). */
const isDay = (d: string): boolean => DAY_SHAPE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
/** Consecutive warn days that open the tracking issue (D-40). */
export const STREAK_FOR_ISSUE = 3;
const MAX_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/** The warn days recorded in a PR body (sorted, valid dates only). */
export function daysIn(body: string | null): readonly string[] {
  const raw = body === null ? null : MARKER.exec(body)?.[1];
  if (raw === undefined || raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((d): d is string => typeof d === 'string' && isDay(d)))].sort() : [];
  } catch {
    return [];
  }
}

/** How many days up to and including `today` are consecutive warn days. */
function streakEndingAt(days: readonly string[], today: string): number {
  let n = 0;
  for (let t = Date.parse(`${today}T00:00:00Z`); days.includes(new Date(t).toISOString().slice(0, 10)); t -= MS_PER_DAY) n += 1;
  return n;
}

export interface StreakDecision {
  /** Warn days to record in the PR body (empty: close or leave no PR). */
  readonly days: readonly string[];
  readonly streak: number;
  readonly openIssue: boolean;
  /** The marker line to put in the PR body. */
  readonly marker: string;
}

/** Today's decision from the previous PR body and whether today's run was an oracle-only failure. */
export function decide(previousBody: string | null, today: string, oracleFailed: boolean): StreakDecision {
  if (!isDay(today)) throw new Error(`today must be a real YYYY-MM-DD day, got "${today}"`);
  const days = oracleFailed ? [...new Set([...daysIn(previousBody), today])].sort().slice(-MAX_DAYS) : [];
  const streak = oracleFailed ? streakEndingAt(days, today) : 0;
  return { days, streak, openIssue: streak >= STREAK_FOR_ISSUE, marker: `<!-- oracle-days: ${JSON.stringify(days)} -->` };
}
