/**
 * Trusted inputs for the `ruleset-state` commit (D-71). The keyless `state` job reads ledgers and id maps from
 * the candidate artefact, which the untrusted candidate job wrote; they are checked here against the CHECKED zip
 * (the bytes the publish job verified and uploaded), and the counts are derived from that zip instead of read.
 * - every declared ruleset with rules has a ledger (for that ruleset) and an id map, and both cover each rule id;
 * - no ledger or id map names a ruleset the zip does not declare.
 * The lock stays the candidate's (provenance only; re-verifying it needs the sources, a go-live task).
 */
import { z } from 'zod';
import { DnrRuleSchema, type DnrRule } from '../dnr/schema.js';
import { parseLedger } from '../postpass/ledger.js';
import { countSlot, serialiseCounts, type SlotCount } from '../postpass/budgets.js';
import { manifestOf } from './manifest.js';
import { readZip, type ZipEntry } from './zip.js';

const RulesFile = z.array(DnrRuleSchema);
const IDMAP_FILE = /^(.+)\.json$/;

export interface CheckedStateInputs {
  /** `ruleset-counts.json` text derived from the zip. */
  readonly counts: string;
}

function jsonOrUndefined(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

interface ZipRuleset { readonly id: string; readonly path: string; readonly rules: readonly DnrRule[]; readonly count: SlotCount }

function rulesetsOf(entries: readonly ZipEntry[]): readonly ZipRuleset[] {
  return manifestOf(entries).ruleResources.map((r) => {
    const entry = entries.find((e) => e.path === r.path);
    if (entry === undefined) throw new Error(`zip has no ${r.path}`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(entry.data);
    const parsed = RulesFile.safeParse(jsonOrUndefined(text));
    if (!parsed.success) throw new Error(`${r.path} is not a DNR rule list`);
    return { id: r.id, path: r.path, rules: parsed.data, count: countSlot(parsed.data, text) };
  });
}

/** A canonical positive integer key (`1`, not `01`, `1e0`, `0x1` or ` 1`). */
const RULE_ID = /^[1-9]\d{0,9}$/;
/** An id-map value: the source lines of one rule, `{ list, line, text }` each (filter-pipeline notes §10). */
const isSourceList = (v: unknown): boolean => Array.isArray(v) && v.every((s: unknown) => typeof s === 'object' && s !== null
  && typeof (s as Record<string, unknown>)['list'] === 'string' && Number.isSafeInteger((s as Record<string, unknown>)['line'])
  && typeof (s as Record<string, unknown>)['text'] === 'string');
const missing = (rules: readonly DnrRule[], known: ReadonlySet<number>): readonly number[] => rules.map((r) => r.id).filter((id) => !known.has(id));
const listed = (ids: readonly number[]): string => `${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` (+${String(ids.length - 5)})` : ''}`;

function ledgerProblems(r: ZipRuleset, text: string | undefined): readonly string[] {
  if (text === undefined) return [`${r.id}: no ledger`];
  let ledger;
  try { ledger = parseLedger(text, `${r.id} ledger`); } catch (e) { return [`${r.id}: ${e instanceof Error ? e.message : String(e)}`]; }
  if (ledger.ruleset !== r.id) return [`${r.id}: the ledger names ruleset "${ledger.ruleset}"`];
  const gone = missing(r.rules, new Set(Object.values(ledger.entries)));
  return gone.length > 0 ? [`${r.id}: rule id(s) ${listed(gone)} not in the ledger`] : [];
}

function idmapProblems(r: ZipRuleset, bytes: Uint8Array | undefined): readonly string[] {
  if (bytes === undefined) return [`${r.id}: no id map`];
  let json: unknown;
  try { json = jsonOrUndefined(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { json = undefined; }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return [`${r.id}: the id map is not a JSON object`];
  const entries = Object.entries(json as Record<string, unknown>);
  const badKey = entries.find(([k]) => !RULE_ID.test(k));
  if (badKey !== undefined) return [`${r.id}: id map key "${badKey[0]}" is not a rule id`];
  const badValue = entries.find(([, v]) => !isSourceList(v));
  if (badValue !== undefined) return [`${r.id}: id map entry ${badValue[0]} is not a list of sources`];
  const gone = missing(r.rules, new Set(entries.map(([k]) => Number(k))));
  return gone.length > 0 ? [`${r.id}: rule id(s) ${listed(gone)} not in the id map`] : [];
}

/**
 * Checks `ledgers` (slot → text) and `idmaps` (file name → bytes) against the checked `zip`; throws with every
 * problem. Returns the counts derived from the zip.
 */
export function checkedStateInputs(zip: Uint8Array, ledgers: ReadonlyMap<string, string>, idmaps: ReadonlyMap<string, Uint8Array>): CheckedStateInputs {
  const rulesets = rulesetsOf(readZip(zip));
  const declared = new Set(rulesets.map((r) => r.id));
  const idmapBySlot = new Map([...idmaps].flatMap(([name, bytes]) => { const id = IDMAP_FILE.exec(name)?.[1]; return id === undefined ? [] : [[id, bytes] as const]; }));
  const problems = [
    ...[...ledgers.keys()].filter((id) => !declared.has(id)).map((id) => `ledger for a ruleset the zip does not declare: ${id}`),
    ...[...idmapBySlot.keys()].filter((id) => !declared.has(id)).map((id) => `id map for a ruleset the zip does not declare: ${id}`),
    ...rulesets.filter((r) => r.rules.length > 0).flatMap((r) => [...ledgerProblems(r, ledgers.get(r.id)), ...idmapProblems(r, idmapBySlot.get(r.id))]),
  ];
  if (problems.length > 0) throw new Error(`state inputs do not match the checked zip:\n  ${problems.join('\n  ')}`);
  return { counts: serialiseCounts(new Map(rulesets.map((r) => [r.id, r.count]))) };
}
