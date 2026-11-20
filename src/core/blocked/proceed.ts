/**
 * "Proceed once" (P2-55, pop-up notes §6.2): the session `allow` rule the worker adds for `c/proceedOnce`.
 * The tab id comes from `sender.tab.id` (never from the message). Two shapes (D-55 / D-55a):
 * - an ordinary destination: that host in that tab, `main_frame`, at 3 (above the redirect 2 and the
 *   block 1), for the tab's lifetime (design review);
 * - a lifted destination (redirect at 5,000,000): one exact address in that tab at 5,000,001, scoped to
 *   the host, case-sensitive, so it never becomes a host-wide bypass of a malware pattern rule.
 * Ids 1–999 of the session range are these rules'; the reconciler carries well-shaped rules in that
 * range through and drops the rest, and the handler prunes rules of tabs that no longer exist.
 */
import type { Hostname } from '../ids.js';
import { POPUP_LIFT_PRIORITY, POPUP_PRIORITY, PROCEED_ONCE_URL_MAX_CHARS, SESSION_ID_RANGE } from '../limits.js';
import type { DnrRule } from '../reconcile/types.js';

/** Session rule ids of "Proceed once" (picker previews, if ever session rules, take 1,000–4,999). */
export const PROCEED_ONCE_ID_RANGE = { min: SESSION_ID_RANGE.min, max: 999 } as const;

const inRange = (id: number): boolean => id >= PROCEED_ONCE_ID_RANGE.min && id <= PROCEED_ONCE_ID_RANGE.max;
/** Printable ASCII without URL-filter syntax (`*`, `^`, `|`): the filter then names exactly one address. */
const EXACT_URL = /^https?:\/\/[\x21-\x29\x2b-\x5d\x5f-\x7b\x7d\x7e]+$/;

/** The address of a lifted Proceed once: canonical, fragment dropped, on exactly `host`; else `null`. */
export function liftedProceedUrl(text: string, host: Hostname): string | null {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username !== '' || u.password !== '' || u.hostname !== host) return null;
  u.hash = '';
  const href = u.href;
  return href.length <= PROCEED_ONCE_URL_MAX_CHARS && EXACT_URL.test(href) ? href : null;
}

/** The address inside `|…|`, when the filter is the exact-URL shape. */
const exactUrlOf = (urlFilter: string): string | null =>
  urlFilter.length > 2 && urlFilter.startsWith('|') && urlFilter.endsWith('|') ? urlFilter.slice(1, -1) : null;

function isBaseShape(rule: DnrRule): boolean {
  const c = rule.condition;
  return inRange(rule.id) && rule.action.type === 'allow' && rule.action.redirect === undefined
    && c.requestDomains?.length === 1 && c.tabIds?.length === 1 && c.resourceTypes?.length === 1 && c.resourceTypes[0] === 'main_frame'
    && c.initiatorDomains === undefined && c.regexFilter === undefined;
}

function isLiftedShape(rule: DnrRule): boolean {
  const c = rule.condition;
  const url = c.urlFilter === undefined ? null : exactUrlOf(c.urlFilter);
  const host = c.requestDomains?.[0] as Hostname | undefined;
  return rule.priority === POPUP_LIFT_PRIORITY.allow && c.isUrlFilterCaseSensitive === true && url !== null && host !== undefined
    && liftedProceedUrl(url, host) === url;
}

/** True for a rule this module would have built: right range and exact shape (either kind). */
export function isProceedOnceRule(rule: DnrRule): boolean {
  if (!isBaseShape(rule)) return false;
  const c = rule.condition;
  const plain = rule.priority === POPUP_PRIORITY.allow && c.urlFilter === undefined && c.isUrlFilterCaseSensitive === undefined;
  return plain || isLiftedShape(rule);
}

/** True for a well-shaped lifted (exact-URL) Proceed once rule. */
export const isLiftedProceedOnceRule = (rule: DnrRule): boolean => isProceedOnceRule(rule) && rule.priority === POPUP_LIFT_PRIORITY.allow;

/** The host a Proceed once rule covers. */
export const proceedOnceHost = (rule: DnrRule): string | undefined => rule.condition.requestDomains?.[0];

function freeId(tabId: number, usedIds: readonly number[]): number | null {
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  const used = new Set(usedIds);
  let id: number = PROCEED_ONCE_ID_RANGE.min;
  while (id <= PROCEED_ONCE_ID_RANGE.max && used.has(id)) id += 1;
  return id > PROCEED_ONCE_ID_RANGE.max ? null : id;
}

/** The rule for `host` in `tabId`, or `null` when the range is full or the tab id is not a tab. */
export function proceedOnceRule(host: Hostname, tabId: number, usedIds: readonly number[]): DnrRule | null {
  const id = freeId(tabId, usedIds);
  if (id === null) return null;
  return { id, priority: POPUP_PRIORITY.allow, action: { type: 'allow' }, condition: { requestDomains: [host], tabIds: [tabId], resourceTypes: ['main_frame'] } };
}

/** The exact-URL rule for a lifted `host` in `tabId`, or `null` (address refused, range full, not a tab). */
export function liftedProceedOnceRule(url: string, host: Hostname, tabId: number, usedIds: readonly number[]): DnrRule | null {
  const exact = liftedProceedUrl(url, host);
  const id = exact === null ? null : freeId(tabId, usedIds);
  if (exact === null || id === null) return null;
  return {
    id,
    priority: POPUP_LIFT_PRIORITY.allow,
    action: { type: 'allow' },
    condition: { urlFilter: `|${exact}|`, isUrlFilterCaseSensitive: true, requestDomains: [host], tabIds: [tabId], resourceTypes: ['main_frame'] },
  };
}
