/**
 * `$badfilter` across every list of the build (filter-pipeline notes §4; S-02c: uBO's unbreak list badfilters
 * EasyList and EasyPrivacy filters). A filter is cancelled when its pattern, exception flag and
 * option set equal a `$badfilter` filter's without the `badfilter` option. Option order is ignored.
 */
import type { NetworkRule } from '@adguard/agtree';
import type { Entry } from '../parse/parse-list.js';
import { hasMod, modsOf, nameOf, valueOf } from './modifiers.js';

/** Keys of the filters cancelled by the build's `$badfilter` filters. */
export type BadfilterSet = ReadonlySet<string>;

const asNetworkRule = (e: Entry): NetworkRule | undefined =>
  e.node?.category === 'Network' && e.node.type === 'NetworkRule' ? e.node : undefined;

/** uBO's option synonyms, so `$3p` and `$third-party` (or `frame` and `subdocument`) are the same filter. */
const SYNONYMS: Readonly<Record<string, string>> = {
  '3p': 'third-party', '1p': '~third-party', 'first-party': '~third-party', '~first-party': 'third-party', '~1p': 'third-party', '~3p': '~third-party',
  frame: 'subdocument', xhr: 'xmlhttprequest', css: 'stylesheet', doc: 'document', ehide: 'elemhide', ghide: 'generichide',
  shide: 'specifichide', from: 'domain', '~frame': '~subdocument', '~xhr': '~xmlhttprequest', '~css': '~stylesheet', '~doc': '~document',
};

const canonicalOption = (name: string): string => (Object.hasOwn(SYNONYMS, name) ? SYNONYMS[name] ?? name : name);

/** Identity of a filter for `$badfilter` matching. */
export function filterKey(node: NetworkRule): string {
  const options = modsOf(node)
    .filter((m) => nameOf(m) !== 'badfilter')
    .map((m) => `${canonicalOption(`${m.exception === true ? '~' : ''}${nameOf(m)}`)}${valueOf(m) === undefined ? '' : `=${valueOf(m) ?? ''}`}`)
    .sort();
  // uBO compares patterns case-insensitively unless the filter is `$match-case` (P1-45 gap 4).
  const pattern = hasMod(node, 'match-case') ? node.pattern.value : node.pattern.value.toLowerCase();
  return `${node.exception ? '@@' : ''}${pattern}$${options.join(',')}`;
}

/** True for a `$badfilter` filter itself (it cancels others and is never converted). */
export const isBadfilter = (e: Entry): boolean => {
  const node = asNetworkRule(e);
  return node !== undefined && hasMod(node, 'badfilter');
};

/** Collects the cancellation keys from every entry of the build. */
export function collectBadfilters(entries: readonly Entry[]): BadfilterSet {
  return new Set(entries.flatMap((e) => {
    const node = asNetworkRule(e);
    return node && hasMod(node, 'badfilter') ? [filterKey(node)] : [];
  }));
}

/** The `$badfilter` key `e` would be cancelled by, or `null` for a non-network entry or a badfilter itself. */
export function cancelKey(e: Entry): string | null {
  const node = asNetworkRule(e);
  return node === undefined || hasMod(node, 'badfilter') ? null : filterKey(node);
}

/** True when `e` is cancelled by one of `bad`. */
export function isBadfiltered(e: Entry, bad: BadfilterSet): boolean {
  const node = asNetworkRule(e);
  return node !== undefined && !hasMod(node, 'badfilter') && bad.has(filterKey(node));
}
