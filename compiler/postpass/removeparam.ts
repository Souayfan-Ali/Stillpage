/**
 * `$removeparam` in uBOL's form (D-34, P2-30). The converter compiles `||host^$removeparam=key` to a
 * redirect whose condition is a regex: the host, then "the query contains `key=`". uBOL writes
 * `urlFilter: '||host^'` with the same `queryTransform`; Chrome does not redirect a request whose
 * transformed URL is unchanged, so the key test adds nothing, and every rewrite frees one regex of the
 * 1,000 static pool. Only the two exact shapes the converter emits are rewritten; anything else stays.
 */
import type { ConvertedRule } from '../convert/convert.js';
import type { DnrRule } from '../dnr/schema.js';
import { canonicalKey } from './canonical.js';

const PREFIX = '^[a-z][a-z0-9+.-]*://(?:[^[:^ascii:]/?#@]*@)?(?:[^[:^ascii:]/?#@]*\\.)?';
const HOST_END = '(?:[^[:^ascii:] a-zA-Z0-9.%_/?#@-][^[:^ascii:]/?#@]*)?(?:/[^[:^ascii:]?#]*)?';
const PATH_END = '(?:[^[:^ascii:] a-zA-Z0-9.%_?#-][^[:^ascii:]?#]*)?';
const QUERY = '\\?(?:[^[:^ascii:]#]*&)?';
/** Escaped host labels, then an optional escaped plain path. */
const HOST_PATH = /^([a-z0-9-]+(?:\\\.[a-z0-9-]+)+)((?:\\\/[A-Za-z0-9_-]+)*)$/;
const PLAIN_KEY = /^[A-Za-z0-9_-]+$/;

/** `||host[/path]^` for a converter removeparam regex of `key`, or `null` for any other shape. */
function urlFilterOf(regex: string, key: string): string | null {
  const tail = `${QUERY}${key}=`;
  if (!PLAIN_KEY.test(key) || !regex.startsWith(PREFIX) || !regex.endsWith(tail)) return null;
  const middle = regex.slice(PREFIX.length, -tail.length);
  const end = middle.endsWith(HOST_END) ? HOST_END : middle.endsWith(PATH_END) ? PATH_END : null;
  if (end === null) return null;
  const match = HOST_PATH.exec(middle.slice(0, -end.length));
  if (match === null) return null;
  const [, host = '', path = ''] = match;
  // A path needs PATH_END, a bare host HOST_END: the converter never mixes them.
  if ((path === '') !== (end === HOST_END)) return null;
  return `||${host.replaceAll('\\.', '.')}${path.replaceAll('\\/', '/')}^`;
}

function rewrite(rule: DnrRule): DnrRule {
  const params = rule.action.redirect?.transform?.queryTransform?.removeParams;
  const { regexFilter, ...condition } = rule.condition;
  if (rule.action.type !== 'redirect' || regexFilter === undefined || params?.length !== 1) return rule;
  const urlFilter = urlFilterOf(regexFilter, params[0] ?? '');
  return urlFilter === null ? rule : { ...rule, condition: { urlFilter, ...condition } };
}

/** Rewrites the converter's removeparam regexes; returns new rule objects, every other rule as it was. */
export function removeparamAsUrlFilter(rules: readonly ConvertedRule[]): readonly ConvertedRule[] {
  return rules.map((r) => {
    const next = rewrite(r.rule);
    return next === r.rule ? r : { ...r, rule: next };
  });
}

const removeParamsOf = (rule: DnrRule): readonly string[] | undefined =>
  rule.action.type === 'redirect' ? rule.action.redirect?.transform?.queryTransform?.removeParams : undefined;

/** The rule's key without its parameter list: same priority, condition and every other action field. */
function keyWithoutParams(rule: DnrRule): string {
  const transform = rule.action.redirect?.transform;
  const query = Object.fromEntries(Object.entries(transform?.queryTransform ?? {}).filter(([k]) => k !== 'removeParams'));
  const action = { ...rule.action, redirect: { ...rule.action.redirect, transform: { ...transform, queryTransform: query } } };
  return canonicalKey({ ...rule, id: 0, action });
}

/**
 * Merges removeparam rules that differ only in their parameter list into one rule whose list is the
 * sorted union (P2-30: ≈ 2,200 single-parameter rules of the params list share conditions). The first
 * rule of a group keeps its place; sources are joined, so attribution loses nothing.
 */
export function mergeRemoveParams(rules: readonly ConvertedRule[]): readonly ConvertedRule[] {
  const groups = new Map<string, { first: ConvertedRule; params: Set<string>; sources: ConvertedRule['sources'][number][] }>();
  const order: (ConvertedRule | string)[] = [];
  for (const r of rules) {
    const params = removeParamsOf(r.rule);
    if (params === undefined) {
      order.push(r);
      continue;
    }
    const key = keyWithoutParams(r.rule);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { first: r, params: new Set(params), sources: [...r.sources] });
      order.push(key);
    } else {
      params.forEach((p) => group.params.add(p));
      group.sources.push(...r.sources);
    }
  }
  return order.map((item) => (typeof item === 'string' ? withParams(groups.get(item)) : item));
}

function withParams(group: { first: ConvertedRule; params: Set<string>; sources: ConvertedRule['sources'][number][] } | undefined): ConvertedRule {
  if (group === undefined) throw new Error('removeparam group lost');
  const { rule } = group.first;
  const transform = rule.action.redirect?.transform;
  const removeParams = [...group.params].sort();
  const action = { ...rule.action, redirect: { ...rule.action.redirect, transform: { ...transform, queryTransform: { ...transform?.queryTransform, removeParams } } } };
  return { rule: { ...rule, action }, sources: group.sources };
}
