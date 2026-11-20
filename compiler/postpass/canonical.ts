/**
 * Canonical form of a DNR rule (filter-pipeline notes §6.1): keys sorted, set-like arrays sorted and de-duplicated,
 * defaults removed, priority explicit. Two rules match the same requests the same way when their
 * canonical keys are equal (the id is not part of the key). Idempotent by construction.
 */
import type { DnrRule } from '../dnr/schema.js';

/** Arrays whose order and repetition do not change what a rule matches or does. */
const SET_KEYS = new Set(['resourceTypes', 'excludedResourceTypes', 'requestDomains', 'excludedRequestDomains',
  'initiatorDomains', 'excludedInitiatorDomains', 'topDomains', 'excludedTopDomains', 'requestMethods',
  'excludedRequestMethods', 'tabIds', 'excludedTabIds', 'removeParams']);
/** Keys whose value equals Chrome's default and can be dropped. */
const DEFAULTS: Readonly<Record<string, unknown>> = { isUrlFilterCaseSensitive: false };
/** DNR's default priority. */
const DEFAULT_PRIORITY = 1;

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

const compare = (a: Json, b: Json): number => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

function canonicalValue(key: string, value: Json): Json {
  if (Array.isArray(value)) {
    const items = (value as readonly Json[]).map((v) => canonicalValue('', v));
    if (!SET_KEYS.has(key)) return items;
    const unique = [...new Map(items.map((v) => [JSON.stringify(v), v])).values()];
    return unique.sort(compare);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Readonly<Record<string, Json>>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined && DEFAULTS[k] !== obj[k]).sort();
    return Object.fromEntries(keys.map((k) => [k, canonicalValue(k, obj[k] ?? null)]));
  }
  return value;
}

/** The rule in canonical form (id kept). Pure; the input is not modified. */
export function canonicalise(rule: DnrRule): DnrRule {
  const { id, priority, ...rest } = rule;
  const body = canonicalValue('', rest as unknown as Json) as unknown as Omit<DnrRule, 'id' | 'priority'>;
  return { id, priority: priority ?? DEFAULT_PRIORITY, ...body };
}

/** Identity of what a rule does, independent of its id: the canonical JSON without `id`. */
export function canonicalKey(rule: DnrRule): string {
  return JSON.stringify(Object.fromEntries(Object.entries(canonicalise(rule)).filter(([k]) => k !== 'id')));
}
