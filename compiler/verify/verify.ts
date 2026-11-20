/**
 * Stage 9 (filter-pipeline notes §2, testing notes §4, P1-31): checks over the emitted files themselves (parsed back from
 * their bytes), independent of how the pipeline built them. Returns failures and warnings; the CLI
 * fails the build on any failure. Cosmetic and scriptlet checks join with their emitters (P1-27…P1-30).
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readCatalog } from '../../src/core/catalog/read.js';
import { mergeRegistrations, REGISTRATIONS_FILE } from '../../src/core/catalog/registrations.js';
import { DEFAULT_PATTERN_BUDGET, POPUP_PRIORITY, REGISTRATION_BUDGET, STATIC_REGEX_POOL, STOCK_PRIORITY_MAX, STOCK_PRIORITY_SHIFT } from '../../src/core/limits.js';
import { DnrRuleSchema, isSafeAction, type DnrRule } from '../dnr/schema.js';
import { rulesetPath } from '../emit/emit.js';
import { isRuleHost, isSiteHost, isSuffixLike } from '../entities/hosts.js';
import { uncoveredDestinations } from '../popups/emit.js';
import { LIFT_FROM, liftedDestinations, liftViolations, type Lifted } from '../popups/lift.js';
import type { Slot } from '../postpass/budgets.js';
import type { BucketedRule } from '../postpass/coalesce.js';
import type { Ledger } from '../postpass/ledger.js';
import { uncoveredRedirects } from '../postpass/split.js';
import { queryKey, queryOf } from '../validate/regex.js';

export interface VerifyInput {
  readonly slots: readonly Slot[];
  readonly popupsId: string;
  /** The `shipped` files (relative path → text). */
  readonly files: ReadonlyMap<string, string>;
  readonly ledgers: ReadonlyMap<string, Ledger>;
  /** Query key → supported (the regex result file). */
  readonly regexResults: Readonly<Record<string, boolean>>;
}

export interface Verdict {
  readonly failures: readonly string[];
}

type Check = (i: VerifyInput, rules: ReadonlyMap<string, readonly DnrRule[]>) => readonly string[];

const RulesFile = z.array(DnrRuleSchema);

/** `JSON.parse` that yields `undefined` instead of throwing (bad output is a failure, not a crash). */
function parseJson(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
const strings = (text: string | undefined): readonly string[] => z.array(z.string()).safeParse(parseJson(text ?? '[]')).data ?? ['<not a JSON string array>'];
const asBucketed = (rules: readonly DnrRule[]): BucketedRule[] => rules.map((rule) => ({ rule, sources: [], bucket: '' }));

/** A `urlFilter` that names no site: absent, `*`, or only a scheme or suffix anchor (`||com^`, `|https://`). */
function namesNoSite(urlFilter: string | undefined): boolean {
  if (urlFilter === undefined) return true;
  const rest = urlFilter.replace(/^(?:\|\||\|https?:\/\/|\||\*)+/, '').replace(/(?:\^|\*|\|)+$/, '');
  return rest === '' || isSuffixLike(rest);
}
const broadHosts = (hosts: readonly string[] | undefined): boolean => hosts === undefined || hosts.some(isSuffixLike);

/**
 * P2-43 (T7): one upstream line must not unblock every host or a whole suffix (`@@*$document`, `@@||com^`)
 * or block navigations to a whole suffix (`||co.uk^$document`) in a skip-review ruleset. A rule narrowed
 * by a regex, a site in its URL filter, or site-only request / initiator domains is not broad.
 */
function isBroadStockRule(r: DnrRule): boolean {
  const c = r.condition;
  const kind = r.action.type === 'block' ? (c.resourceTypes ?? []).includes('main_frame') : ['allow', 'allowAllRequests'].includes(r.action.type);
  return kind && c.regexFilter === undefined && namesNoSite(c.urlFilter) && broadHosts(c.requestDomains)
    && (c.initiatorDomains === undefined || c.initiatorDomains.some(isSuffixLike));
}

/** Parses every slot's file; schema failures are reported, not thrown. */
function parseSlots(i: VerifyInput): { rules: Map<string, readonly DnrRule[]>; problems: string[] } {
  const rules = new Map<string, readonly DnrRule[]>();
  const problems: string[] = [];
  for (const s of i.slots) {
    const text = i.files.get(rulesetPath(s.id));
    if (text === undefined) { problems.push(`${s.id}: no ruleset file`); continue; }
    const parsed = RulesFile.safeParse(parseJson(text));
    if (parsed.success) rules.set(s.id, parsed.data);
    else problems.push(`${s.id}: schema: ${parsed.error.issues.slice(0, 3).map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`);
  }
  return { rules, problems };
}

const idChecks: Check = (i, all) => [...all].flatMap(([slot, rules]) => {
  const ids = rules.map((r) => r.id);
  const ledger = i.ledgers.get(slot);
  const known = new Set(Object.values(ledger?.entries ?? {}));
  return [
    ...(new Set(ids).size === ids.length ? [] : [`${slot}: duplicate rule ids`]),
    ...ids.filter((id) => !known.has(id)).slice(0, 3).map((id) => `${slot}: id ${String(id)} is not in the ledger`),
  ];
});

const purityChecks: Check = (i, all) => i.slots.flatMap((s) => {
  const rules = all.get(s.id) ?? [];
  const bad = rules.find((r) => isSafeAction(r.action) === s.unsafe);
  return bad ? [`${s.id}: ${bad.action.type} rule ${String(bad.id)} in a ${s.unsafe ? '-x' : 'safe'} file`] : [];
});

const redirectChecks: Check = (i, all) => i.slots.filter((s) => s.unsafe).flatMap((s) => {
  const missing = uncoveredRedirects(asBucketed(all.get(s.id.slice(0, -2)) ?? []), asBucketed(all.get(s.id) ?? []));
  return missing.length === 0 ? [] : [`${s.id}: ${String(missing.length)} redirect(s) without a covering block`];
});

const regexChecks: Check = (i, all) => {
  const rules = [...all.values()].flat();
  const unchecked = rules.filter((r) => { const q = queryOf(r); return q !== undefined && i.regexResults[queryKey(q)] !== true; });
  const total = rules.filter((r) => r.condition.regexFilter !== undefined).length;
  return [
    ...(unchecked.length === 0 ? [] : [`${String(unchecked.length)} regex rule(s) without a supported Chromium result`]),
    ...(total > STATIC_REGEX_POOL ? [`${String(total)} regex over every ruleset > ${String(STATIC_REGEX_POOL)}`] : []),
  ];
};

const priorityChecks: Check = (i, all) => i.slots.flatMap((s) => {
  const rules = all.get(s.id) ?? [];
  const ok = s.id === i.popupsId
    ? (r: DnrRule) => r.priority === (r.action.type === 'allow' ? POPUP_PRIORITY.allow : POPUP_PRIORITY.block)
    : (r: DnrRule) => (r.priority ?? 1) > STOCK_PRIORITY_SHIFT && (r.priority ?? 1) <= STOCK_PRIORITY_MAX;
  const bad = rules.filter((r) => !ok(r));
  return bad.length === 0 ? [] : [`${s.id}: ${String(bad.length)} rule(s) outside the ${s.id === i.popupsId ? 'pop-up' : 'stock'} priority band`];
});

const popupChecks: Check = (i, all) => {
  const rules = all.get(i.popupsId) ?? [];
  const destinations = strings(i.files.get('popup-destinations.json'));
  const strict = strings(i.files.get('popup-strict-sites.json'));
  const hosts = rules.flatMap((r) => [...(r.condition.requestDomains ?? []), ...(r.condition.initiatorDomains ?? []), ...(r.condition.excludedInitiatorDomains ?? []),
    ...(r.condition.urlFilter === undefined ? [] : [r.condition.urlFilter.replace(/^\|\||^\|https?:\/\//, '').split(/[/^:*|?]/)[0] ?? ''])]);
  const notSites = [...[...hosts, ...destinations].filter((h) => !isRuleHost(h)), ...strict.filter((h) => !isSiteHost(h))];
  const shape = rules.filter((r) => !['block', 'allow'].includes(r.action.type) || r.condition.resourceTypes?.join() !== 'main_frame'
    || r.condition.regexFilter !== undefined || !/^(?:\|\||\|https?:\/\/)/.test(r.condition.urlFilter ?? '||') || r.condition.topDomains !== undefined);
  const uncovered = uncoveredDestinations(destinations, asBucketed(rules));
  return [
    ...(shape.length === 0 ? [] : [`popups: ${String(shape.length)} rule(s) not block/allow on main_frame with a host-anchored URL`]),
    ...(uncovered.length === 0 ? [] : [`popup-destinations.json: ${String(uncovered.length)} host(s) not covered by popups`]),
    ...(notSites.length === 0 ? [] : [`pop-up artefacts name ${String(notSites.length)} host(s) that are not site hosts (e.g. ${notSites.slice(0, 3).join(', ')})`]),
  ];
};

const LiftedFile = z.record(z.string(), z.array(z.string()));
const sameLift = (a: Lifted, b: Lifted): boolean => JSON.stringify(a) === JSON.stringify(b);

/** D-55a item 8b: `popup-lifted.json` against the emitted rulesets, as a hard assertion. */
const liftChecks: Check = (i, all) => {
  const parsed = LiftedFile.safeParse(parseJson(i.files.get('popup-lifted.json')));
  if (!parsed.success) return ['popup-lifted.json: missing or not an object of host lists'];
  const lifted = parsed.data;
  const destinations = new Set(strings(i.files.get('popup-destinations.json')));
  const stray = Object.values(lifted).flat().filter((h) => !destinations.has(h));
  const v = liftViolations(lifted, all);
  const classes = (['malware', 'allow', 'unjustified'] as const).filter((k) => v[k].length > 0).map((k) => `popup-lifted.json: ${k}: ${v[k].slice(0, 5).join(', ')}`);
  const implied = v.hostlessAllows.length > 0 ? lifted : liftedDestinations([...destinations], all).lifted;
  return [
    ...Object.keys(lifted).filter((k) => !(LIFT_FROM as readonly string[]).includes(k)).map((k) => `popup-lifted.json: key "${k}" is not a justifying ruleset`),
    ...(stray.length === 0 ? [] : [`popup-lifted.json: ${String(stray.length)} host(s) not in popup-destinations.json (e.g. ${stray.slice(0, 3).join(', ')})`]),
    ...v.hostlessAllows.map((r) => `popup-lifted.json: hostless main_frame allow: ${r}`),
    ...classes,
    ...(sameLift(lifted, implied) ? [] : ['popup-lifted.json: differs from the lift the rulesets imply']),
  ];
};

/** The catalog as the worker reads it: `registrations.json` merged in after its SHA-256 check (D-26). */
function shippedCatalog(files: ReadonlyMap<string, string>): { readonly raw: unknown; readonly errors: readonly string[] } {
  const raw = parseJson(files.get('catalog.json'));
  const ref = (raw as { registrations?: { sha256?: unknown } } | undefined)?.registrations;
  if (ref === undefined) return { raw, errors: [] };
  const text = files.get(REGISTRATIONS_FILE);
  if (text === undefined) return { raw, errors: [`catalog names ${REGISTRATIONS_FILE} but there is no file`] };
  if (createHash('sha256').update(text).digest('hex') !== ref.sha256) return { raw, errors: [`${REGISTRATIONS_FILE} does not match the catalog's SHA-256`] };
  const merged = mergeRegistrations(raw, parseJson(text));
  return merged === null ? { raw, errors: [`invalid ${REGISTRATIONS_FILE}`] } : { raw: merged, errors: [] };
}

const catalogChecks: Check = (i) => {
  const shipped = shippedCatalog(i.files);
  if (shipped.errors.length > 0) return [...shipped.errors];
  const read = readCatalog(shipped.raw);
  if (!read.ok) return read.errors.map((e) => `catalog: ${e}`);
  const ids = Object.keys(read.value.rulesets);
  const inPacks = Object.values(read.value.packs).flatMap((p) => [...p.rulesets]);
  const regs = Object.values(read.value.packs).filter((p) => p.default).flatMap((p) => [...p.registrations]);
  const patterns = regs.reduce((n, r) => n + r.hosts.length, 0);
  return [
    ...ids.filter((id) => !i.files.has(rulesetPath(id))).map((id) => `catalog names ${id} but there is no file`),
    ...ids.filter((id) => !(inPacks as readonly string[]).includes(id)).map((id) => `catalog: ruleset ${id} is in no pack`),
    ...(patterns > DEFAULT_PATTERN_BUDGET ? [`${String(patterns)} match patterns for the default packs > ${String(DEFAULT_PATTERN_BUDGET)}`] : []),
    ...(regs.length > REGISTRATION_BUDGET ? [`${String(regs.length)} registrations > ${String(REGISTRATION_BUDGET)}`] : []),
    ...i.slots.filter((s) => !ids.includes(s.id)).map((s) => `catalog misses slot ${s.id}`),
  ];
};

const budgetChecks: Check = (i, all) => {
  const read = readCatalog(parseJson(i.files.get('catalog.json')));
  if (!read.ok) return [];
  return [...all].flatMap(([id, rules]) => {
    const c = read.value.rulesets[id as never];
    const regex = rules.filter((r) => r.condition.regexFilter !== undefined).length;
    return c !== undefined && (rules.length > c.maxRules || regex > c.maxRegex) ? [`${id}: ${String(rules.length)} / ${String(regex)} over the catalog ceiling`] : [];
  });
};

const breadthChecks: Check = (i, all) => i.slots.filter((s) => !s.unsafe && s.id !== i.popupsId).flatMap((s) => {
  const broad = (all.get(s.id) ?? []).filter(isBroadStockRule);
  return broad.length === 0 ? [] : [`${s.id}: ${String(broad.length)} rule(s) allow every host or a whole suffix, or block navigations to one (e.g. id ${String(broad[0]?.id)})`];
});

const CHECKS: readonly Check[] = [idChecks, purityChecks, redirectChecks, regexChecks, priorityChecks, popupChecks, liftChecks, breadthChecks, catalogChecks, budgetChecks];

/** Runs every artefact check of testing notes §4 that has artefacts in this build. */
export function verifyArtefacts(i: VerifyInput): Verdict & { readonly rules: ReadonlyMap<string, readonly DnrRule[]> } {
  const { rules, problems } = parseSlots(i);
  return { failures: [...problems, ...CHECKS.flatMap((c) => c(i, rules))], rules };
}
