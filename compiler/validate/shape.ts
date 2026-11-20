/**
 * Shape check for every emitted static rule (filter-pipeline notes §6.5, P1-23). One rule Chromium refuses to
 * index makes the whole extension fail to load (S-18: a `urlFilter` starting with `||*`, a non-ASCII
 * `urlFilter`), so the compiler drops and logs such rules before emitting. The checks follow the
 * indexing errors of Chromium's `declarative_net_request/indexed_rule.cc`; regex validity is
 * Chromium's own `isRegexSupported` (`regex.ts`), and the emitted files are also loaded unpacked.
 */
import type { DnrAction, DnrCondition, DnrRule } from '../dnr/schema.js';

const ASCII = /^[\x20-\x7e]*$/;
const DOMAIN_KEYS = ['requestDomains', 'excludedRequestDomains', 'initiatorDomains', 'excludedInitiatorDomains', 'topDomains',
  'excludedTopDomains'] as const;
/** Lists whose emptiness Chromium rejects (an empty exclusion list is merely pointless; also rejected for clarity). */
const NON_EMPTY_KEYS = [...DOMAIN_KEYS, 'resourceTypes', 'requestMethods'] as const;
const FRAME_TYPES: ReadonlySet<string> = new Set(['main_frame', 'sub_frame']);
const RESOURCE_TYPE_COUNT = 15;

type Check = (c: DnrCondition, a: DnrAction) => string | undefined;

const overlap = (a: readonly string[] | undefined, b: readonly string[] | undefined): string | undefined =>
  a?.find((x) => b?.includes(x));

const urlFilterCheck: Check = (c) => {
  if (c.urlFilter === undefined) return undefined;
  if (c.urlFilter === '') return 'empty urlFilter';
  if (!ASCII.test(c.urlFilter)) return `non-ASCII urlFilter "${c.urlFilter}"`;
  if (c.urlFilter.startsWith('||*')) return 'urlFilter starts with "||*"';
  return c.regexFilter === undefined ? undefined : 'both urlFilter and regexFilter';
};

const listCheck: Check = (c) => {
  const empty = NON_EMPTY_KEYS.find((k) => c[k]?.length === 0);
  if (empty !== undefined) return `empty ${empty}`;
  for (const key of DOMAIN_KEYS) {
    const bad = c[key]?.find((d) => d === '' || !ASCII.test(d) || d !== d.toLowerCase());
    if (bad !== undefined) return `${key}: "${bad}" is not a lower-case ASCII domain`;
  }
  const type = overlap(c.resourceTypes, c.excludedResourceTypes);
  if (type !== undefined) return `"${type}" in both resourceTypes and excludedResourceTypes`;
  if (c.resourceTypes === undefined && (c.excludedResourceTypes?.length ?? 0) >= RESOURCE_TYPE_COUNT) return 'every resource type excluded';
  const method = overlap(c.requestMethods, c.excludedRequestMethods);
  return method === undefined ? undefined : `"${method}" in both requestMethods and excludedRequestMethods`;
};

const allowAllCheck: Check = (c, a) => {
  if (a.type !== 'allowAllRequests') return undefined;
  const ok = c.resourceTypes?.every((t) => FRAME_TYPES.has(t)) ?? false;
  return ok ? undefined : 'allowAllRequests needs resourceTypes within main_frame / sub_frame';
};

const redirectCheck: Check = (c, a) => {
  if (a.type !== 'redirect') return a.redirect === undefined ? undefined : `redirect data on a ${a.type} rule`;
  const r = a.redirect ?? {};
  const targets = [r.extensionPath, r.transform, r.url, r.regexSubstitution].filter((x) => x !== undefined);
  if (targets.length !== 1) return 'a redirect needs exactly one redirect target';
  if (r.extensionPath !== undefined && !r.extensionPath.startsWith('/')) return `extensionPath "${r.extensionPath}" must start with /`;
  return r.regexSubstitution !== undefined && c.regexFilter === undefined ? 'regexSubstitution needs regexFilter' : undefined;
};

const headerCheck: Check = (_c, a) => {
  const ops = [...(a.requestHeaders ?? []), ...(a.responseHeaders ?? [])];
  if (a.type !== 'modifyHeaders') return ops.length === 0 ? undefined : `header operations on a ${a.type} rule`;
  if (ops.length === 0) return 'modifyHeaders with no header operation';
  for (const op of ops) {
    if (op.header === '') return 'empty header name';
    if (op.operation === 'remove' && op.value !== undefined) return `header "${op.header}": remove takes no value`;
    if (op.operation !== 'remove' && (op.value ?? '') === '') return `header "${op.header}": ${op.operation} needs a value`;
  }
  return undefined;
};

const CHECKS: readonly Check[] = [urlFilterCheck, listCheck, allowAllCheck, redirectCheck, headerCheck];

/** Why Chromium would refuse to index `rule`, or undefined when its shape is acceptable. */
export function shapeProblem(rule: DnrRule): string | undefined {
  for (const check of CHECKS) {
    const problem = check(rule.condition, rule.action);
    if (problem !== undefined) return problem;
  }
  return undefined;
}
