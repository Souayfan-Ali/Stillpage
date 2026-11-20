/**
 * `q/matchedRules` (P2-11, UI notes §4): Chrome's matched rules for one tab, counted per category and
 * bucket. `getMatchedRules` needs `activeTab` for that tab (the toolbar click); without it, or on the
 * quota, the last answer for the same page is returned marked stale, else `unavailable` (S-06). Answers
 * are cached per tab in `storage.session` for 30 s, keyed by a SHA-256 of the tab's address so another
 * page never shows the previous page's counts (design review, P2-11) and no address is stored (security review
 * LOW). Without host access Chrome hides the address; then nothing is cached (review HIGH: every page
 * would share one key). Rule ids only, never an address in an answer.
 */
import * as v from 'valibot';
import { BUCKETS_FILE, readBuckets, type BucketMap } from '../core/buckets/buckets.js';
import { UNCONFIRMED_BUCKETS } from '../core/buckets/unconfirmed.js';
import type { MessageError, Response } from '../core/messaging/parse.js';
import { MatchedRulesSchema, summariseMatches, type Counts, type MatchedRules, type OwnRuleKind, type RuleMatch } from '../core/messaging/matched.js';
import type { DnrRule } from '../core/reconcile/types.js';
import type { Ports } from '../platform/ports.js';

/** How long one answer is reused for the same page (UI notes §4). */
export const MATCHED_CACHE_MS = 30_000;
export const matchedKey = (tabId: number): string => `matched:${String(tabId)}`;

const EMPTY_MAP: BucketMap = { buckets: [], rulesets: {} };
const CachedSchema = v.strictObject({ page: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)), summary: MatchedRulesSchema });

/** The map is read and validated once per worker wake (review MEDIUM); a failure is retried next time. */
const maps = new WeakMap<Ports, Promise<BucketMap>>();

const failure = (code: MessageError['code'], message: string): Response<never> => ({ ok: false, error: { code, message } });

/** The packaged map; an unreadable one counts everything as "Other" (logged), it does not hide the total. */
async function loadMap(ports: Ports): Promise<BucketMap | null> {
  try {
    const map = readBuckets(JSON.parse(await ports.package.readText(BUCKETS_FILE)));
    if (map !== null) return map;
    ports.log.error(`${BUCKETS_FILE} is invalid`);
  } catch (error) {
    ports.log.error(`${BUCKETS_FILE} unreadable`, error);
  }
  return null;
}

async function readMap(ports: Ports): Promise<BucketMap> {
  const memo = maps.get(ports);
  if (memo !== undefined) return memo;
  const loading = loadMap(ports);
  maps.set(ports, loading.then((m) => m ?? EMPTY_MAP));
  const map = await loading;
  if (map === null) maps.delete(ports);
  return map ?? EMPTY_MAP;
}

/** SHA-256 of the tab's address, hex; `null` when Chrome hides the address. */
async function pageKey(url: string | null): Promise<string | null> {
  if (url === null) return null;
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function kindOf(rule: DnrRule | undefined): OwnRuleKind {
  const type = rule?.action.type;
  if (type === undefined || type === 'allow' || type === 'allowAllRequests') return 'drop';
  return type === 'redirect' ? 'popup' : 'other';
}

/** Classifies our own dynamic and session rules by their action (read only when one matched). */
async function ownKinds(ports: Ports, matches: readonly RuleMatch[]): Promise<(rulesetId: string, ruleId: number) => OwnRuleKind> {
  const wants = (id: string): boolean => matches.some((m) => m.rulesetId === id);
  const [dynamic, session] = await Promise.all([
    wants('_dynamic') ? ports.dnr.getDynamicRules() : Promise.resolve([]),
    wants('_session') ? ports.dnr.getSessionRules() : Promise.resolve([]),
  ]);
  const byArea = { _dynamic: new Map(dynamic.map((r) => [r.id, r])), _session: new Map(session.map((r) => [r.id, r])) };
  return (rulesetId, ruleId) => kindOf(rulesetId === '_dynamic' || rulesetId === '_session' ? byArea[rulesetId].get(ruleId) : undefined);
}

async function readCached(ports: Ports, tabId: number, page: string | null): Promise<Counts | null> {
  if (page === null) return null;
  const parsed = v.safeParse(CachedSchema, await ports.session.get(matchedKey(tabId)).catch((error: unknown) => {
    // A cache miss: the counts are read fresh.
    ports.log.warn('matched-rules cache unreadable', error);
    return undefined;
  }));
  if (!parsed.success || parsed.output.page !== page || parsed.output.summary.kind !== 'counts') return null;
  return parsed.output.summary;
}

async function fresh(ports: Ports, tabId: number, page: string | null): Promise<Counts> {
  const matches = await ports.dnr.getMatchedRules(tabId);
  const [map, own] = await Promise.all([readMap(ports), ownKinds(ports, matches)]);
  const summary = summariseMatches(map, matches, own, ports.now(), UNCONFIRMED_BUCKETS);
  if (page === null) return summary;
  await ports.session.set(matchedKey(tabId), { page, summary }).catch((error: unknown) => {
    ports.log.warn('matched-rules cache not written', error);
  });
  return summary;
}

export async function matchedRules(tabId: number, ports: Ports): Promise<Response<MatchedRules>> {
  let tab: { readonly url: string | null } | null;
  try {
    tab = await ports.tabs.get(tabId);
  } catch (error) {
    ports.log.error('q/matchedRules failed', error);
    return failure('internal', 'q/matchedRules failed');
  }
  if (tab === null) return failure('not-found', 'no such tab');
  const page = await pageKey(tab.url);
  const cached = await readCached(ports, tabId, page);
  if (cached !== null && ports.now() - cached.at < MATCHED_CACHE_MS) return { ok: true, data: cached };
  try {
    return { ok: true, data: await fresh(ports, tabId, page) };
  } catch (error) {
    // No `activeTab` grant for this tab, or the quota: say so honestly instead of guessing.
    ports.log.warn('getMatchedRules failed', error);
    return { ok: true, data: cached === null ? { kind: 'unavailable' } : { ...cached, stale: true } };
  }
}
