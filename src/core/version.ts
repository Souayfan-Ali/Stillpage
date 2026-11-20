/**
 * Version scheme `MAJOR.MINOR.RULES_DAY.RULES_HHMM` (update-strategy notes §7, ADR-008, P2-03). RULES_DAY counts days
 * since 2025-12-31 (2026-01-01 = 1); RULES_HHMM is the UTC time of the list snapshot as an integer
 * (06:05 → 605). The UI derives the rules date from the version, so no file outside `rule_resources`
 * changes in a ruleset release.
 *
 * Zero imports, no DOM: release tooling (`compiler/release`, `compiler/store`, `compiler/eligibility`) imports
 * it too. The UI's date formatter is `src/ui/rulesVersion.ts`.
 */

/** The code line: bumped only by a full release. */
export interface CodeLine { readonly major: number; readonly minor: number }

export interface RulesVersion extends CodeLine { readonly day: number; readonly hhmm: number }

const RULES_EPOCH_MS = Date.UTC(2025, 11, 31);
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MAX_PART = 65_535;
const MAX_PARTS = 4;
const HOURS = 24;
const MINUTES = 60;
const HHMM_BASE = 100;
/** A snapshot may run ahead of the release clock by this much; more is a clock fault (a future version blocks every later release). */
const MAX_CLOCK_SKEW_MS = 5 * MS_PER_MINUTE;
/** Chrome's version parts: integers 0–65535 without leading zeros or signs. */
const PART = /^(0|[1-9]\d{0,4})$/;

function checkPart(name: string, n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > MAX_PART) throw new Error(`${name} must be an integer in 0–${String(MAX_PART)}, got ${String(n)}`);
}

/** Version for a list snapshot taken at `snapshot`; `now` is the release clock. Throws on any out-of-scheme value. */
export function encodeVersion(line: CodeLine, snapshot: Date, now: Date): string {
  checkPart('MAJOR', line.major);
  checkPart('MINOR', line.minor);
  const t = snapshot.getTime();
  if (Number.isNaN(t) || Number.isNaN(now.getTime())) throw new Error('invalid snapshot or clock time');
  if (t > now.getTime() + MAX_CLOCK_SKEW_MS) throw new Error(`snapshot ${snapshot.toISOString()} is in the future (clock ${now.toISOString()})`);
  const day = Math.floor((t - RULES_EPOCH_MS) / MS_PER_DAY);
  if (day < 1) throw new Error(`snapshot ${snapshot.toISOString()} is before 2026-01-01 (day 1)`);
  if (day > MAX_PART) throw new Error(`RULES_DAY ${String(day)} exceeds 65535`);
  const minuteOfDay = Math.floor((t - RULES_EPOCH_MS - day * MS_PER_DAY) / MS_PER_MINUTE);
  const hhmm = Math.floor(minuteOfDay / MINUTES) * HHMM_BASE + (minuteOfDay % MINUTES);
  return `${String(line.major)}.${String(line.minor)}.${String(day)}.${String(hhmm)}`;
}

/** Parts of a canonical Chrome version (1–4 parts), or undefined. */
function partsOf(version: string): readonly number[] | undefined {
  const parts = version.split('.');
  if (parts.length > MAX_PARTS || !parts.every((p) => PART.test(p))) return undefined;
  const nums = parts.map(Number);
  return nums.every((n) => n <= MAX_PART) ? nums : undefined;
}

/** The four scheme parts, or undefined for any version outside the scheme (a dev build `0.0.1`, day 0, 24:00, …). */
export function decodeVersion(version: string): RulesVersion | undefined {
  const p = partsOf(version);
  if (p?.length !== MAX_PARTS) return undefined;
  const [major = 0, minor = 0, day = 0, hhmm = 0] = p;
  const isTime = Math.floor(hhmm / HHMM_BASE) < HOURS && hhmm % HHMM_BASE < MINUTES;
  return day >= 1 && isTime ? { major, minor, day, hhmm } : undefined;
}

/** The snapshot instant the version encodes, or undefined. */
export function rulesDateOf(version: string): Date | undefined {
  const v = decodeVersion(version);
  if (v === undefined) return undefined;
  const minutes = Math.floor(v.hhmm / HHMM_BASE) * MINUTES + (v.hhmm % HHMM_BASE);
  return new Date(RULES_EPOCH_MS + v.day * MS_PER_DAY + minutes * MS_PER_MINUTE);
}

/** Chrome's order: numeric part by part, missing parts are zero. Throws on a non-version. */
export function compareVersions(a: string, b: string): number {
  const pa = partsOf(a);
  const pb = partsOf(b);
  if (pa === undefined || pb === undefined) throw new Error(`not a version: ${pa === undefined ? a : b}`);
  for (let i = 0; i < MAX_PARTS; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
