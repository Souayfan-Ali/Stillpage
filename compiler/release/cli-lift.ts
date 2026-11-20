/**
 * `npm run -s release -- lift-drift --base <zip> --candidate <zip> --today <YYYY-MM-DD> --out <json>` (D-73).
 *
 * The daily ruleset job's drift report (D-55a): the SHIPPED `popup-lifted.json` (from the published base zip;
 * a ruleset-only release never changes it) checked against the candidate zip's rulesets. Drift never fails the
 * run: it writes the report and prints one `::warning::` with the D-55a window (48 h malware, 7 days otherwise),
 * relative to first detection (first-seen tracking is a go-live task). A base without the lift file (published
 * before D-55) only warns. Unreadable or invalid input throws: the run fails closed like any other pre-gate failure.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DnrRuleSchema, type DnrRule } from '../dnr/schema.js';
import { liftDriftReport, type LiftDriftReport, type RulesBySlot } from '../popups/lift.js';
import { manifestOf } from './manifest.js';
import { readZip, type ZipEntry } from './zip.js';

const LIFTED_PATH = 'popup-lifted.json';
const LiftedFile = z.record(z.string(), z.array(z.string()));
const RulesFile = z.array(DnrRuleSchema);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface LiftDriftResult {
  readonly report: LiftDriftReport & { readonly detectedOn: string; readonly baseHasLiftFile: boolean };
  /** The workflow annotation to print, or `null` without drift. */
  readonly annotation: string | null;
}

function jsonOf(entries: readonly ZipEntry[], at: string, which: string): unknown {
  const entry = entries.find((e) => e.path === at);
  if (entry === undefined) throw new Error(`${which} zip has no ${at}`);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.data));
  } catch (e) {
    throw new Error(`${which} zip: ${at} is not JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

function rulesOf(candidate: Uint8Array): RulesBySlot {
  const entries = readZip(candidate);
  return new Map(manifestOf(entries).ruleResources.map((r): [string, readonly DnrRule[]] => {
    const parsed = RulesFile.safeParse(jsonOf(entries, r.path, 'candidate'));
    if (!parsed.success) throw new Error(`candidate zip: ${r.path} is not a DNR rule list`);
    return [r.id, parsed.data];
  }));
}

/** The drift report of a base (shipped lift file) against a candidate (new rulesets). Throws on bad input. */
export function liftDriftOfZips(i: { readonly base: Uint8Array; readonly candidate: Uint8Array; readonly today: string }): LiftDriftResult {
  if (!DATE.test(i.today)) throw new Error(`--today must be YYYY-MM-DD, got "${i.today}"`);
  const base = readZip(i.base);
  const rules = rulesOf(i.candidate);
  // A base published before D-55 ships no lift file: nothing can drift (security review MEDIUM 3: never stop the daily).
  if (!base.some((e) => e.path === LIFTED_PATH)) {
    const none = { malware: [], allow: [], unjustified: [], hostlessAllows: [] };
    return { report: { schema: 1, drift: false, fullReleaseWithinHours: null, violations: none, detectedOn: i.today, baseHasLiftFile: false },
      annotation: `::warning::lift drift: the published base has no ${LIFTED_PATH} (built before D-55); nothing to check` };
  }
  const lifted = LiftedFile.safeParse(jsonOf(base, LIFTED_PATH, 'base'));
  if (!lifted.success) throw new Error(`base zip: ${LIFTED_PATH} is not an object of host lists`);
  const report = { ...liftDriftReport(lifted.data, rules), detectedOn: i.today, baseHasLiftFile: true };
  const cls = report.violations.malware.length > 0 ? 'malware' : 'other';
  const annotation = report.fullReleaseWithinHours === null ? null
    : `::warning::lift drift (${cls}): full release required within ${String(report.fullReleaseWithinHours)} h of first detection`;
  return { report, annotation };
}

export async function liftDriftCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: {
    base: { type: 'string' }, candidate: { type: 'string' }, today: { type: 'string' }, out: { type: 'string' } } });
  const { base, candidate, today, out } = values;
  if (base === undefined || candidate === undefined || today === undefined || out === undefined) {
    throw new Error('--base, --candidate, --today and --out are required');
  }
  const result = liftDriftOfZips({ base: new Uint8Array(await readFile(base)), candidate: new Uint8Array(await readFile(candidate)), today });
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(result.report, null, 1)}\n`);
  process.stdout.write(`${result.annotation ?? 'lift drift: none'}\n`);
}
