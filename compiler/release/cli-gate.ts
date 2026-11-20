/**
 * `npm run release -- gate --base <zip> --candidate <zip> --record <published record.json>
 *   --ledgers-before <published release's ledger dir> [--ledgers-after <dir>] [--regex-results <file>] [--store-state <file>] [--no-load]`
 *
 * Runs the eligibility gate (P2-02) and prints the verdict as JSON. E9 loads every ruleset of the candidate
 * unpacked in Playwright's Chromium (skipped with `--no-load`, which then fails E9); the DNR table tests and the
 * smoke corpus of E9 run as their own workflow steps (`npm run test:dnr`, P2-05). E11 reads a store-state file
 * (the store client's `status` output, P2-04); without one E11 fails and the run is skipped.
 * Exit codes: 0 publish, 1 abort, 3 open a PR, 4 route to the full-release train, 5 skip this run.
 */
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readLedgers } from '../build/node-ports.js';
import { loadRulesets } from '../chromium/node-ports.js';
import { manifestOf } from './manifest.js';
import { ReleaseRecordSchema, sha256Hex } from './record.js';
import { readZip } from './zip.js';
import { runGate } from '../eligibility/gate.js';
import { rulesOf } from '../eligibility/rules.js';
import type { GateOutcome, LoadReport, StoreState } from '../eligibility/types.js';

const EXIT_CODES: Readonly<Record<GateOutcome, number>> = { publish: 0, abort: 1, 'open-pr': 3, 'route-to-full': 4, skip: 5 };

const RegexResultsSchema = z.looseObject({ results: z.record(z.string(), z.boolean()) });
const StoreStateSchema = z.strictObject({
  published: z.boolean(), publishedVersion: z.string().optional(), warned: z.boolean(), pendingSubmission: z.boolean(),
}).refine((s) => !s.published || s.publishedVersion !== undefined, 'a published item must name its published version');

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8')) as unknown;

async function loadReport(candidate: Uint8Array): Promise<LoadReport> {
  const entries = readZip(candidate);
  const unpacked = { bytes: candidate, entries: new Map(entries.map((e) => [e.path, e])), manifest: manifestOf(entries) };
  const files = unpacked.manifest.ruleResources.map((r) => ({ id: r.id, parsed: rulesOf(unpacked, r.path) }));
  const bad = files.flatMap((f) => (f.parsed.ok ? [] : [f.parsed.error]));
  if (bad.length > 0) return { ok: false, problems: bad };
  const loaded = await loadRulesets(files.map((f) => ({ id: f.id, rules: f.parsed.ok ? f.parsed.rules : [] })));
  const missing = files.map((f) => f.id).filter((id) => !loaded.enabled.includes(id));
  return { ok: missing.length === 0, problems: missing.map((id) => `Chromium did not enable ${id}`) };
}

async function storeState(file: string | undefined): Promise<StoreState | undefined> {
  if (file === undefined) return undefined;
  const s = StoreStateSchema.parse(await readJson(file));
  return { published: s.published, warned: s.warned, pendingSubmission: s.pendingSubmission, ...(s.publishedVersion !== undefined && { publishedVersion: s.publishedVersion }) };
}

export async function gateCommand(args: readonly string[], root: string): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: {
    base: { type: 'string' }, candidate: { type: 'string' }, record: { type: 'string' },
    'ledgers-before': { type: 'string' }, 'ledgers-after': { type: 'string', default: path.join(root, 'lists/ledger') },
    'regex-results': { type: 'string', default: path.join(root, 'dist/compiler/regex-results.json') },
    'store-state': { type: 'string' }, 'no-load': { type: 'boolean', default: false } } });
  if (values.base === undefined || values.candidate === undefined || values.record === undefined || values['ledgers-before'] === undefined) {
    throw new Error('--base, --candidate, --record and --ledgers-before (the published release\'s ledgers) are required');
  }
  if (await realpath(values['ledgers-before']) === await realpath(values['ledgers-after'])) throw new Error('--ledgers-before and --ledgers-after are the same directory');
  const base = new Uint8Array(await readFile(values.base));
  const candidate = new Uint8Array(await readFile(values.candidate));
  const slots = manifestOf(readZip(candidate)).ruleResources.map((r) => r.id);
  const store = await storeState(values['store-state']);
  const load = values['no-load'] ? undefined : await loadReport(candidate);
  const verdict = runGate({
    base, candidate, record: ReleaseRecordSchema.parse(await readJson(values.record)),
    ledgers: { before: await readLedgers(values['ledgers-before'], slots), after: await readLedgers(values['ledgers-after'], slots) },
    regexSupported: new Map(Object.entries(RegexResultsSchema.parse(await readJson(values['regex-results'])).results)),
    ...(load !== undefined && { load }), ...(store !== undefined && { store }),
  });
  // The verdict names the exact candidate it judged; `publish-ruleset` refuses any other zip.
  const named = { candidateSha256: sha256Hex(candidate), candidateVersion: manifestOf(readZip(candidate)).version, ...verdict };
  process.stdout.write(`${JSON.stringify(named, null, 1)}\n`);
  process.exitCode = EXIT_CODES[verdict.outcome];
}
