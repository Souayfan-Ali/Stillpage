/**
 * Pop-up filter shapes (filter-pipeline notes §7a, pop-up notes §6.1, S-18; P1-49). Each `$popup` / `$popunder` / `$all`
 * filter becomes exactly one of: a `main_frame` rule for the `popups` ruleset, a set of strict sites,
 * or a log entry with a `popup-*` reason. The converter never sees these filters' pop-up half.
 *
 * - `||host^` → `block` with `requestDomains` (and the host is a pop-up destination);
 *   `||host/path`, `|https://host/…` → `block` with `urlFilter`;
 * - `third-party` → `domainType: thirdParty`, `domain=` → `initiatorDomains` / `excludedInitiatorDomains`
 *   (on `main_frame` the initiator is the opener, S-18); `topDomains` is never used;
 * - `@@…` → `allow`; host-less patterns, `||*…` and regex → `popup-generic-pattern` (they could match
 *   ordinary navigation); no URL but sites (`*$popup,3p,domain=a|b`) → strict sites, entity forms by
 *   observed expansion (D-20).
 */
import type { NetworkRule } from '@adguard/agtree';
import { POPUP_PRIORITY } from '../../src/core/limits.js';
import type { DnrCondition, DnrRule } from '../dnr/schema.js';
import { expandEntities, isEntity } from '../entities/expand.js';
import { isRuleHost, isSiteHost } from '../entities/hosts.js';
import { findMod, modsOf, nameOf, splitPipe, valueOf } from '../normalise/modifiers.js';
import type { ReasonCode } from '../normalise/reasons.js';
import { isRejected, runSteps } from '../normalise/transforms.js';
import { shapeProblem } from '../validate/shape.js';

export type PopupShape = 'host' | 'host-path' | 'context-3p' | 'context-domain' | 'exception';

export type PopupOutcome =
  | { readonly kind: 'rule'; readonly shape: PopupShape; readonly rule: DnrRule; readonly destination?: string }
  | { readonly kind: 'strict'; readonly sites: readonly string[]; readonly lost: readonly string[] }
  | { readonly kind: 'log'; readonly reason: ReasonCode; readonly detail?: string };

const TYPE_NAMES = new Set(['script', 'image', 'stylesheet', 'css', 'object', 'xmlhttprequest', 'xhr', 'subdocument', 'frame',
  'ping', 'beacon', 'websocket', 'media', 'font', 'other', 'webtransport', 'webbundle', 'doc', 'document']);
/** Options that carry no pop-up meaning here (types are the network half; `important` has no band to use). */
const IGNORED = new Set(['popup', 'popunder', 'all', 'important', 'reason', 'match-case', 'domain', 'from', ...TYPE_NAMES]);
const PARTY: Readonly<Record<string, 'thirdParty' | 'firstParty'>> = { 'third-party': 'thirdParty', '3p': 'thirdParty', 'first-party': 'firstParty', '1p': 'firstParty' };
const HOST = /^\|\|([a-z0-9][a-z0-9.-]*)\^$/;
const ANCHORED = /^(?:\|\|[^/^:*|]+[/^:]|\|https?:\/\/[^/*^|]+[/^])/;
const NO_URL = new Set(['', '*', '|', '||']);

const log = (reason: ReasonCode, detail?: string): PopupOutcome => ({ kind: 'log', reason, ...(detail !== undefined && { detail }) });

function partyOf(node: NetworkRule): 'thirdParty' | 'firstParty' | undefined {
  const m = modsOf(node).find((x) => Object.hasOwn(PARTY, nameOf(x)));
  if (m === undefined) return undefined;
  const t = PARTY[nameOf(m)];
  return m.exception === true ? (t === 'thirdParty' ? 'firstParty' : 'thirdParty') : t;
}

function unsupportedOption(node: NetworkRule): string | undefined {
  const m = modsOf(node).find((x) => !IGNORED.has(nameOf(x)) && !Object.hasOwn(PARTY, nameOf(x)));
  if (m !== undefined) return nameOf(m);
  const popup = modsOf(node).find((x) => nameOf(x) === 'popup' || nameOf(x) === 'popunder');
  return popup?.exception === true ? '~popup' : undefined;
}

/** `*$popup,3p,domain=a|b`: every listed site becomes a strict site (pop-up notes §7.6). */
function strictOutcome(node: NetworkRule, stems: ReadonlyMap<string, readonly string[]>): PopupOutcome {
  if (node.exception) return log('popup-no-target', 'exception without a URL');
  const option = unsupportedOption(node);
  if (option !== undefined) return log('popup-unsupported', `option ${option}`);
  const entries = [findMod(node, 'domain'), findMod(node, 'from')].flatMap((m) => (m ? splitPipe(valueOf(m)) : []));
  const positive = entries.filter((d) => !d.startsWith('~') && !d.startsWith('/'));
  const expanded = expandEntities(positive.filter(isEntity), stems);
  const sites = [...new Set([...positive.filter((d) => !isEntity(d)), ...expanded.hosts])].filter(isSiteHost).sort();
  return sites.length === 0 ? log('popup-no-target', expanded.lost.length > 0 ? `entity sites not observed: ${expanded.lost.join(',')}` : 'no URL and no site')
    : { kind: 'strict', sites, lost: expanded.lost };
}

function contextOf(node: NetworkRule): DnrCondition {
  const m = findMod(node, 'domain');
  const domains = m === undefined ? [] : splitPipe(valueOf(m));
  const include = domains.filter((d) => !d.startsWith('~')).sort();
  const exclude = domains.filter((d) => d.startsWith('~')).map((d) => d.slice(1)).sort();
  const party = partyOf(node);
  return {
    ...(party && { domainType: party }),
    ...(include.length > 0 && { initiatorDomains: include }),
    ...(exclude.length > 0 && { excludedInitiatorDomains: exclude }),
  };
}

/** The host of an anchored pattern (`||host…`, `|https://host…`). */
const hostOfPattern = (pattern: string): string => pattern.replace(/^\|\||^\|https?:\/\//, '').split(/[/^:*|?]/)[0] ?? '';

/** Every `domain=` entry must be a site host; entity or malformed values make the filter unsupported. */
const badContextDomain = (node: NetworkRule): string | undefined => {
  const m = findMod(node, 'domain');
  return (m === undefined ? [] : splitPipe(valueOf(m))).map((d) => d.replace(/^~/, '')).find((d) => !isSiteHost(d));
};

function ruleOutcome(node: NetworkRule): PopupOutcome {
  const pattern = node.pattern.value;
  if (pattern.startsWith('/') || pattern.startsWith('||*') || !ANCHORED.test(`${pattern}/`)) return log('popup-generic-pattern', pattern);
  // No rule for a whole TLD, a public suffix or a partial IP (`||com^$popup`, `@@||co.uk^$popup`).
  if (!isRuleHost(hostOfPattern(pattern))) return log('popup-generic-pattern', pattern);
  const badDomain = badContextDomain(node);
  if (badDomain !== undefined) return log('popup-unsupported', `domain ${badDomain}`);
  const option = unsupportedOption(node);
  if (option !== undefined) return log('popup-unsupported', `option ${option}`);
  const host = HOST.exec(pattern)?.[1];
  const context = contextOf(node);
  const caseSensitive = findMod(node, 'match-case') !== undefined && host === undefined;
  const condition: DnrCondition = {
    resourceTypes: ['main_frame'], ...(host !== undefined ? { requestDomains: [host] } : { urlFilter: pattern }),
    ...(caseSensitive && { isUrlFilterCaseSensitive: true }), ...context,
  };
  const action = node.exception ? 'allow' : 'block';
  const rule: DnrRule = { id: 1, priority: POPUP_PRIORITY[action], action: { type: action }, condition };
  const problem = shapeProblem(rule);
  if (problem !== undefined) return log('popup-invalid-rule', problem);
  const hasContext = Object.keys(context).length > 0;
  const shape: PopupShape = node.exception ? 'exception' : hasContext ? (context.domainType && !context.initiatorDomains && !context.excludedInitiatorDomains ? 'context-3p' : 'context-domain')
    : host !== undefined ? 'host' : 'host-path';
  return { kind: 'rule', shape, rule, ...(shape === 'host' && host !== undefined && { destination: host }) };
}

/** The outcome for one pop-up filter; `stems` indexes the build's hosts for entity expansion. */
export function popupOutcome(node: NetworkRule, stems: ReadonlyMap<string, readonly string[]>): PopupOutcome {
  if (NO_URL.has(node.pattern.value)) return strictOutcome(node, stems);
  const r = runSteps({ node, fixes: [] });
  if (isRejected(r)) return log('popup-unsupported', r.reject);
  if (NO_URL.has(r.node.pattern.value)) return strictOutcome(r.node, stems);
  return ruleOutcome(r.node);
}
