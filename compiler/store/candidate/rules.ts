/**
 * Rule-level part of the publish job's candidate check (D-58a, D-58f). Every rule of every changed safe
 * ruleset is judged, not only the diff:
 * - compact canonical JSON, unique positive integer ids, keys ⊆ {id, priority, action, condition}, `action`
 *   exactly `{type}` with a skip-review safe type (an unknown type is unsafe), condition keys ⊆ Chrome's static
 *   DNR condition keys (kept equal to `compiler/dnr/schema.ts` by a test), `priority` a positive integer;
 * - no catch-all: `allow` / `allowAllRequests`, or a `block` of `main_frame`, that names no site or only a public
 *   suffix (no, empty or suffix-containing request / initiator domains; a URL filter of anchors and wildcards only
 *   or a suffix such as `||com^`, `||co.uk^`; a trivial regex). Excluded domains and `topDomains` do not scope a
 *   rule here. A strict superset of `compiler/verify`'s breadth check (D-72, closes the D-58e suffix gap);
 * - the E10 growth guard against the base ruleset (10 % rules, 25 % bytes; equal to `compiler/eligibility/rules.ts`
 *   by a test).
 * Dependency-free: no imports at all (D-58b).
 */

const SAFE_ACTIONS: ReadonlySet<string> = new Set(['block', 'allow', 'allowAllRequests', 'upgradeScheme']);
const RULE_KEYS: ReadonlySet<string> = new Set(['id', 'priority', 'action', 'condition']);
/** Static DNR condition keys (Chrome 145+), as `compiler/dnr/schema.ts`. */
export const CONDITION_KEYS: readonly string[] = ['urlFilter', 'regexFilter', 'isUrlFilterCaseSensitive', 'initiatorDomains',
  'excludedInitiatorDomains', 'requestDomains', 'excludedRequestDomains', 'topDomains', 'excludedTopDomains', 'resourceTypes',
  'excludedResourceTypes', 'requestMethods', 'excludedRequestMethods', 'domainType', 'responseHeaders', 'excludedResponseHeaders'];
const CONDITION_KEY_SET: ReadonlySet<string> = new Set(CONDITION_KEYS);
/** E10 (update-strategy notes §3.3). */
export const RULE_GROWTH_LIMIT = 0.1;
export const BYTE_GROWTH_LIMIT = 0.25;

type Json = Record<string, unknown>;

/** Port of `compiler/entities/hosts.ts` (D-72), kept equal by a test: second-level labels under two-letter ccTLDs. */
const CC_SECOND_LEVEL: ReadonlySet<string> = new Set(['ac', 'co', 'com', 'edu', 'gob', 'go', 'gov', 'gv', 'ltd', 'ne', 'net', 'or', 'org', 'plc', 'sch']);
const TLD = /^[a-z]{2,63}$|^xn--[a-z0-9-]{1,59}$/;

/** True for something that looks like a public suffix: `com`, `co.uk`, `com.au` (equal to `compiler/entities/hosts.ts`). */
export function isSuffixLike(s: string): boolean {
  const labels = s.split('.');
  const [first, last] = [labels[0] ?? '', labels.at(-1) ?? ''];
  if (labels.length === 1) return TLD.test(first);
  return labels.length === 2 && last.length === 2 && CC_SECOND_LEVEL.has(first);
}

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const strictText = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const unknownKeys = (o: Json, known: ReadonlySet<string>): readonly string[] => Object.keys(o).filter((k) => !known.has(k));

const HOST_ANCHOR = /^(?:\|\||\|https?:\/\/)/;
/** A literal host in a regex source: labels joined by `\.` (`a\.example`, `co\.uk`), or after a bare `\.` (`[^/]*\.com`). */
const REGEX_HOST = /[a-z0-9-]+(?:\\\.[a-z0-9-]+)+|(?<![a-z0-9-])\\\.[a-z0-9-]+(?:\\\.[a-z0-9-]+)*/g;

const trimEnd = (s: string): string => s.replace(/(?:\^|\*|\|)+$/, '');

/**
 * A URL filter of anchors and wildcards only (`*`, `||`, `|https://`, `^`), or one whose host part names only a
 * suffix: `||com^`, `||*.co.uk^`, `*.com^`, `||.com^`, `||com.^`, `||com:443^`, `||com/*` (security review MEDIUM 1).
 * Not broad: a host that runs into a wildcard (`||kinepolis.*` before a path, `||revancedapk.`: a label prefix names a site),
 * and a host followed by a path or query (`||com^/x.js`: as narrow as the path-only `/x.js`, left to the domain checks).
 */
function urlNamesNoSite(urlFilter: unknown): boolean {
  if (urlFilter === undefined) return true;
  if (typeof urlFilter !== 'string') return false;
  const lower = urlFilter.toLowerCase();
  const rest = lower.replace(/^(?:\|\||\|https?:\/\/|\||\*)+/, '');
  if (trimEnd(rest) === '') return true;
  if (!HOST_ANCHOR.test(lower) && !rest.startsWith('.')) return isSuffixLike(trimEnd(rest));
  const [, rawHost = '', after = ''] = /^[*.]*([a-z0-9.-]*)(.*)$/s.exec(rest) ?? [];
  if (after.startsWith('*') || (rawHost.endsWith('.') && after === '')) return false;
  const host = rawHost.replace(/\.+$/, '');
  return /^[\^|*/:0-9]*$/.test(after) && (host === '' || isSuffixLike(host));
}

/** A regex that matches any URL (`.*`, `^https?://`, empty, …). */
function regexIsTrivial(regex: unknown): boolean {
  if (regex === undefined) return true;
  if (typeof regex !== 'string') return false;
  return regex.replace(/^\^/, '').replace(/^https\??:(?:\\?\/){2}/, '').replace(/\.[*+?]?|\$/g, '') === '';
}

/**
 * For an allow: a regex that is trivial, or whose literal hosts are all suffixes (`^https?://[^/]*\.com/`,
 * `\.co\.uk`; security review MEDIUM 2). A regex with no literal host names a path, like a path-only URL filter. Page blocks keep the trivial check only: the
 * malware lists scope site regexes by a TLD in `requestDomains` (badware), and an over-broad block is not a bypass.
 */
function regexNamesNoSite(regex: unknown): boolean {
  if (regexIsTrivial(regex) || typeof regex !== 'string') return regexIsTrivial(regex);
  const hosts = (regex.toLowerCase().match(REGEX_HOST) ?? []).map((h) => h.replaceAll('\\.', '.').replace(/^\./, ''));
  return hosts.length > 0 && hosts.every(isSuffixLike);
}

/** Absent, empty, or naming a whole suffix: the domain list does not narrow the rule to sites. */
const noSiteHosts = (hosts: unknown): boolean => hosts === undefined
  || (Array.isArray(hosts) && (hosts.length === 0 || hosts.some((h) => typeof h === 'string' && isSuffixLike(h.toLowerCase()))));

function isCatchAll(type: string, c: Json): boolean {
  const types = c['resourceTypes'];
  const blocksPages = type === 'block' && Array.isArray(types) && types.includes('main_frame');
  const allows = type === 'allow' || type === 'allowAllRequests';
  const regexBroad = allows ? regexNamesNoSite(c['regexFilter']) : regexIsTrivial(c['regexFilter']);
  return (blocksPages || allows) && urlNamesNoSite(c['urlFilter']) && regexBroad
    && noSiteHosts(c['requestDomains']) && noSiteHosts(c['initiatorDomains']);
}

/** Problems of one rule's shape and action; the id is checked by the caller. */
function shapeProblems(at: string, rule: Json): readonly string[] {
  const extra = unknownKeys(rule, RULE_KEYS);
  if (extra.length > 0) return [`${at} has unknown keys ${extra.join(', ')}`];
  if (rule['priority'] !== undefined && !isPositiveInt(rule['priority'])) return [`${at} has a priority that is not a positive integer`];
  const action = rule['action'];
  const type = isRecord(action) && typeof action['type'] === 'string' ? action['type'] : 'none';
  if (!SAFE_ACTIONS.has(type)) return [`${at} has action "${type}", not a skip-review safe action`];
  if (isRecord(action) && Object.keys(action).length !== 1) return [`${at} has an action with keys other than "type"`];
  const c = rule['condition'];
  if (!isRecord(c)) return [`${at} has no condition object`];
  const badKeys = unknownKeys(c, CONDITION_KEY_SET);
  if (badKeys.length > 0) return [`${at} has unknown condition keys ${badKeys.join(', ')}`];
  return isCatchAll(type, c) ? [`${at} is a catch-all "${type}" that names no site`] : [];
}

function parseRules(path: string, bytes: Uint8Array): readonly unknown[] | string {
  let text: string;
  let raw: unknown;
  try {
    text = strictText(bytes);
    raw = JSON.parse(text);
  } catch (e) {
    return `${path}: not JSON (${message(e)})`;
  }
  if (!Array.isArray(raw)) return `${path}: not a rule list`;
  return JSON.stringify(raw) === text ? raw : `${path}: not in the compact canonical JSON form (duplicate keys or reformatting)`;
}

const change = (before: number, after: number): number => (before === 0 ? (after === 0 ? 0 : Infinity) : Math.abs(after - before) / before);
const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;

function growthProblems(path: string, base: Uint8Array, candidate: Uint8Array, count: number): readonly string[] {
  const before = parseRules(path, base);
  if (typeof before === 'string') return [`base ${before}`];
  const rules = change(before.length, count);
  const bytes = change(base.length, candidate.length);
  return [
    ...(rules > RULE_GROWTH_LIMIT ? [`${path}: rule count ${String(before.length)} → ${String(count)} (${pct(rules)}), more than the growth guard`] : []),
    ...(bytes > BYTE_GROWTH_LIMIT ? [`${path}: bytes changed by ${pct(bytes)}, more than the growth guard`] : []),
  ];
}

/** Every problem of a changed safe ruleset (`base` = the published bytes of the same path). */
export function rulesetProblems(path: string, base: Uint8Array, candidate: Uint8Array): readonly string[] {
  const rules = parseRules(path, candidate);
  if (typeof rules === 'string') return [rules];
  const ids = new Set<number>();
  const problems = rules.flatMap((rule: unknown, i): readonly string[] => {
    const id = isRecord(rule) ? rule['id'] : undefined;
    if (!isRecord(rule) || !isPositiveInt(id)) return [`${path}: rule ${String(i)} has no positive integer id`];
    if (ids.has(id)) return [`${path}: rule id ${String(id)} is used twice`];
    ids.add(id);
    return shapeProblems(`${path}: rule ${String(id)}`, rule);
  });
  return problems.length > 0 ? problems : growthProblems(path, base, candidate, rules.length);
}
