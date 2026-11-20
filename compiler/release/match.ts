/**
 * Incident drills (P2-51): does a release block a given URL? A throwaway extension carries the release's
 * rulesets with their manifest default state, and Chromium's `testMatchOutcome` answers (the CLI runs it).
 * Pure parts here: the drill extension's files and the verdict from the matched rules.
 */
import type { Ledger } from '../postpass/ledger.js';
import { manifestOf, UNSAFE_SUFFIX } from './manifest.js';
import type { ZipEntry } from './zip.js';

export interface MatchedRule {
  readonly rulesetId: string;
  readonly ruleId: number;
}

interface RuleLike {
  readonly id: number;
  readonly priority?: number;
  readonly action: { readonly type: string };
}

const ALLOWING: ReadonlySet<string> = new Set(['allow', 'allowAllRequests', 'upgradeScheme']);
const DEFAULT_PRIORITY = 1;
/** DNR's order between actions of equal priority. */
const ACTION_ORDER = ['allow', 'allowAllRequests', 'block', 'upgradeScheme', 'redirect', 'modifyHeaders'];
const rank = (type: string): number => { const i = ACTION_ORDER.indexOf(type); return i === -1 ? ACTION_ORDER.length : i; };

/** `blocked` when the highest-priority matched rule blocks (or redirects); `allowed` otherwise. */
export function outcomeOf(matched: readonly MatchedRule[], rules: ReadonlyMap<string, readonly object[]>): 'blocked' | 'allowed' {
  const found = matched.map((m) => {
    const rule = (rules.get(m.rulesetId) as readonly RuleLike[] | undefined)?.find((r) => r.id === m.ruleId);
    if (rule === undefined) throw new Error(`unknown rule ${m.rulesetId}/${String(m.ruleId)}`);
    return rule;
  });
  const top = [...found].sort((a, b) => (b.priority ?? DEFAULT_PRIORITY) - (a.priority ?? DEFAULT_PRIORITY) || rank(a.action.type) - rank(b.action.type))[0];
  return top === undefined || ALLOWING.has(top.action.type) ? 'allowed' : 'blocked';
}

/** Files of the drill extension for `entries` (a release zip): its rulesets, default-enabled as shipped. */
export function matchExtension(entries: readonly ZipEntry[]): ReadonlyMap<string, Uint8Array> {
  const m = manifestOf(entries);
  const byPath = new Map(entries.map((e) => [e.path, e.data]));
  const manifest = {
    manifest_version: 3, name: 'incident-drill', version: '0.0.1', background: { service_worker: 'bg.js' },
    permissions: ['declarativeNetRequest', 'declarativeNetRequestFeedback'], host_permissions: ['<all_urls>'],
    declarative_net_request: { rule_resources: m.ruleResources.map((r) => ({ id: r.id, enabled: r.enabled, path: r.path })) },
  };
  const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
  return new Map<string, Uint8Array>([
    ['manifest.json', encode(JSON.stringify(manifest))],
    ['bg.js', encode('// incident drill\n')],
    ...m.ruleResources.map((r): [string, Uint8Array] => [r.path, byPath.get(r.path) ?? encode('[]')]),
  ]);
}

const HOST = /^[a-z0-9.-]+$/;
const DRILL_PRIORITY = 10;

/**
 * Drill input (P2-51): the safe rulesets of a release with one bad but eligible rule added to `ubo` — a block on
 * `host`'s documents, with a fresh id from the ledger (ids never move, so a later rebuild keeps it reserved).
 */
export function withBadRule(entries: readonly ZipEntry[], ledger: Ledger, host: string): { rulesets: ReadonlyMap<string, Uint8Array>; ledger: Ledger } {
  if (!HOST.test(host)) throw new Error(`not a host: ${host}`);
  const m = manifestOf(entries);
  const byPath = new Map(entries.map((e) => [e.path, e.data]));
  const safe = m.ruleResources.filter((r) => !r.id.endsWith(UNSAFE_SUFFIX));
  const id = ledger.nextId;
  const bad = { id, priority: DRILL_PRIORITY, action: { type: 'block' }, condition: { requestDomains: [host], resourceTypes: ['main_frame'] } };
  const rulesets = new Map(safe.map((r): [string, Uint8Array] => {
    const data = byPath.get(r.path) ?? new TextEncoder().encode('[]');
    if (r.id !== ledger.ruleset) return [r.path, data];
    const rules = JSON.parse(new TextDecoder().decode(data)) as unknown[];
    return [r.path, new TextEncoder().encode(JSON.stringify([...rules, bad]))];
  }));
  return { rulesets, ledger: { ...ledger, nextId: id + 1, entries: { ...ledger.entries, [`r:incident-drill-${host}`]: id } } };
}
