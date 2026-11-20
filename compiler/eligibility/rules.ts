/**
 * Rule-level checks of the eligibility gate (update-strategy notes §3.3): E6 safe-only diff, E7 ledger stability, E8
 * ceilings and regex support, E10 growth guard. Pure over the unpacked zips and the inputs.
 */
import { z } from 'zod';
import { DEFAULT_RULE_BUDGET } from '../../src/core/limits.js';
import { DnrRuleSchema, type DnrRule } from '../dnr/schema.js';
import type { Ledger } from '../postpass/ledger.js';
import { UNSAFE_SUFFIX } from '../release/manifest.js';
import { queryKey, queryOf } from '../validate/regex.js';
import type { Unpacked } from './files.js';
import { result, type CheckResult } from './types.js';

/** Skip-review safe actions (research notes 02 §4.2), named explicitly so a new action type is unsafe by default. */
const SAFE_ACTIONS: ReadonlySet<string> = new Set(['block', 'allow', 'allowAllRequests', 'upgradeScheme']);
/** E10 growth guard: rule count and byte size change per ruleset (update-strategy notes §3.3). */
const RULE_GROWTH_LIMIT = 0.1;
const BYTE_GROWTH_LIMIT = 0.25;
const CATALOG_PATH = 'catalog.json';

const RulesSchema = z.array(DnrRuleSchema);
const CatalogCeilings = z.looseObject({
  rulesets: z.record(z.string(), z.looseObject({ maxRules: z.number().int().nonnegative(), maxRegex: z.number().int().nonnegative() })),
});

type Parsed = { readonly ok: true; readonly rules: readonly DnrRule[] } | { readonly ok: false; readonly error: string };

const strictText = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/** Problems that make a rule list ambiguous: not in the compiler's compact form (duplicate keys, reformatting), or duplicate ids. */
function ambiguity(path: string, text: string, raw: unknown, rules: readonly DnrRule[]): string | undefined {
  if (JSON.stringify(raw) !== text) return `${path}: not in the compiler's canonical JSON form (duplicate keys or reformatting)`;
  const ids = new Set(rules.map((r) => r.id));
  return ids.size === rules.length ? undefined : `${path}: a rule id is used twice`;
}

/** Rules of `path` in `zip`; an absent file is an empty ruleset. */
export function rulesOf(zip: Unpacked, path: string): Parsed {
  const entry = zip.entries.get(path);
  if (entry === undefined) return { ok: true, rules: [] };
  try {
    const text = strictText(entry.data);
    const raw: unknown = JSON.parse(text);
    const parsed = RulesSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `${path}: not a valid rule list (${parsed.error.issues[0]?.message ?? 'schema'})` };
    const problem = ambiguity(path, text, raw, parsed.data);
    return problem === undefined ? { ok: true, rules: parsed.data } : { ok: false, error: problem };
  } catch (e) {
    return { ok: false, error: `${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const safeResources = (zip: Unpacked) => zip.manifest.ruleResources.filter((r) => !r.id.endsWith(UNSAFE_SUFFIX));
const isSafe = (r: DnrRule | undefined): boolean => r === undefined || SAFE_ACTIONS.has(r.action.type);
const same = (a: DnrRule | undefined, b: DnrRule | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

function unsafeChanges(id: string, before: readonly DnrRule[], after: readonly DnrRule[]): readonly string[] {
  const old = new Map(before.map((r) => [r.id, r]));
  const next = new Map(after.map((r) => [r.id, r]));
  const ids = [...new Set([...old.keys(), ...next.keys()])].sort((a, b) => a - b);
  return ids.filter((n) => !same(old.get(n), next.get(n)) && !(isSafe(old.get(n)) && isSafe(next.get(n))))
    .map((n) => `${id}: rule ${String(n)} is added, removed or changed with an unsafe action`);
}

/** E6: every added, removed or changed rule of a safe ruleset is safe in its old and new form. */
export function checkE6(base: Unpacked, candidate: Unpacked): CheckResult {
  const problems = safeResources(base).flatMap((r) => {
    const before = rulesOf(base, r.path);
    const after = rulesOf(candidate, r.path);
    if (!before.ok) return [before.error];
    if (!after.ok) return [after.error];
    return unsafeChanges(r.id, before.rules, after.rules);
  });
  return result('E6', 'abort', problems);
}

function ledgerProblems(slot: string, before: Ledger, after: Ledger | undefined): readonly string[] {
  if (after === undefined) return [`${slot}: ledger missing after the build`];
  const moved = Object.entries(before.entries).filter(([k, id]) => after.entries[k] !== id).map(([k]) => `${slot}: key ${k} changed id or was dropped`);
  const reused = Object.entries(after.entries).filter(([k, id]) => !Object.hasOwn(before.entries, k) && id < before.nextId)
    .map(([k, id]) => `${slot}: new key ${k} reuses id ${String(id)}`);
  const shrunk = after.nextId < before.nextId ? [`${slot}: nextId went down`] : [];
  return [...moved, ...reused, ...shrunk];
}

/**
 * E7: no existing key changed id; no id reused. Every slot that has rules in the base must have a ledger of
 * the published release (`before`), so an empty or missing `before` cannot pass by comparing nothing.
 */
export function checkE7(base: Unpacked, ledgers: { readonly before: ReadonlyMap<string, Ledger>; readonly after: ReadonlyMap<string, Ledger> }): CheckResult {
  const missing = base.manifest.ruleResources.filter((r) => !ledgers.before.has(r.id)).filter((r) => {
    const rules = rulesOf(base, r.path);
    return !rules.ok || rules.rules.length > 0;
  }).map((r) => `${r.id}: no ledger of the published release`);
  return result('E7', 'abort', [...missing, ...[...ledgers.before].flatMap(([slot, l]) => ledgerProblems(slot, l, ledgers.after.get(slot)))]);
}

function ceilingsOf(zip: Unpacked): z.infer<typeof CatalogCeilings> | string {
  const entry = zip.entries.get(CATALOG_PATH);
  if (entry === undefined) return 'candidate has no catalog.json';
  try {
    const parsed = CatalogCeilings.safeParse(JSON.parse(strictText(entry.data)));
    return parsed.success ? parsed.data : 'catalog.json has no readable ceilings';
  } catch {
    return 'catalog.json is not readable JSON';
  }
}

function regexProblems(id: string, rules: readonly DnrRule[], supported: ReadonlyMap<string, boolean>): readonly string[] {
  return rules.flatMap((r) => {
    const q = queryOf(r);
    if (q === undefined || supported.get(queryKey(q)) === true) return [];
    return [`${id}: regex of rule ${String(r.id)} is ${supported.has(queryKey(q)) ? 'not supported' : 'not checked'} by isRegexSupported`];
  });
}

/** E8: per-ruleset counts within the catalog ceilings, default-on total within the budget, every regex supported. */
export function checkE8(candidate: Unpacked, supported: ReadonlyMap<string, boolean>): CheckResult {
  const ceilings = ceilingsOf(candidate);
  if (typeof ceilings === 'string') return result('E8', 'open-pr', [ceilings]);
  let defaultTotal = 0;
  const problems = candidate.manifest.ruleResources.flatMap((res) => {
    const parsed = rulesOf(candidate, res.path);
    if (!parsed.ok) return [parsed.error];
    const max = ceilings.rulesets[res.id];
    const regex = parsed.rules.filter((r) => r.condition.regexFilter !== undefined).length;
    if (res.enabled) defaultTotal += parsed.rules.length;
    if (max === undefined) return [`${res.id}: no ceiling in catalog.json`];
    return [
      ...(parsed.rules.length > max.maxRules ? [`${res.id}: ${String(parsed.rules.length)} rules > ceiling ${String(max.maxRules)}`] : []),
      ...(regex > max.maxRegex ? [`${res.id}: ${String(regex)} regex rules > ceiling ${String(max.maxRegex)}`] : []),
      ...regexProblems(res.id, parsed.rules, supported),
    ];
  });
  const total = defaultTotal > DEFAULT_RULE_BUDGET ? [`default-on total ${String(defaultTotal)} > ${String(DEFAULT_RULE_BUDGET)}`] : [];
  return result('E8', 'open-pr', [...problems, ...total]);
}

const change = (before: number, after: number): number => (before === 0 ? (after === 0 ? 0 : Infinity) : Math.abs(after - before) / before);
const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;

/** E10: growth guard, > 10 % rule-count or > 25 % byte change in any safe ruleset. */
export function checkE10(base: Unpacked, candidate: Unpacked): CheckResult {
  const problems = safeResources(base).flatMap((r) => {
    const before = rulesOf(base, r.path);
    const after = rulesOf(candidate, r.path);
    if (!before.ok || !after.ok) return [];
    const rules = change(before.rules.length, after.rules.length);
    const bytes = change(base.entries.get(r.path)?.data.length ?? 0, candidate.entries.get(r.path)?.data.length ?? 0);
    return [
      ...(rules > RULE_GROWTH_LIMIT ? [`${r.id}: rule count ${String(before.rules.length)} → ${String(after.rules.length)} (${pct(rules)})`] : []),
      ...(bytes > BYTE_GROWTH_LIMIT ? [`${r.id}: bytes changed by ${pct(bytes)}`] : []),
    ];
  });
  return result('E10', 'open-pr', problems);
}
