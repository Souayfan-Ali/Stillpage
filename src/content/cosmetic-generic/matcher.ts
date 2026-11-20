/**
 * Generic matching for one frame (P2-24, cosmetic notes §5): the packs' generic data for this host, minus
 * every loaded pack's `unhide` list and the host's own exceptions; `$generichide` switches the whole
 * frame off. A token (`#id`, `.class`) is looked up at most once per frame; a selector is handed out at
 * most once. Pure: no DOM.
 */
import { exceptionsFor, isGenericData, isGenericOff, lookupToken, type GenericData } from '../../core/generic/data.js';
import type { Hostname } from '../../core/ids.js';

/** Tokens remembered per frame; beyond this, tokens are looked up again (cheap, bounded memory). */
const MAX_SEEN_TOKENS = 100_000;
/** Whole `class` strings remembered per frame (P3-17): most elements repeat a string already split. */
const MAX_SEEN_CLASSES = 20_000;

export interface Matcher {
  /** Selectors to apply on every page of the host (no leading token). */
  readonly always: readonly string[];
  /** New selectors keyed on any of `tokens` (each token and selector reported once per frame). */
  match(tokens: Iterable<string>): readonly string[];
  /**
   * `match(tokensOf(id, classes))`, without splitting a `class` string met before (P3-17). Same result:
   * every token of a remembered string was looked up then, and its selectors already handed out.
   */
  matchElement(id: unknown, classes: unknown): readonly string[];
}

/** The matcher for `host`, or `null` when there is nothing to do (no data, or generic hiding is off). */
export function createMatcher(queued: readonly unknown[], host: Hostname): Matcher | null {
  const packs = queued.filter(isGenericData);
  if (packs.length === 0 || packs.some((d) => isGenericOff(d, host))) return null;
  const excluded = new Set<string>([...packs.flatMap((d) => d.unhide), ...packs.flatMap((d) => exceptionsFor(d, host))]);
  const handed = new Set<string>(excluded);
  // Capped (security review MEDIUM-2): a page inventing endless class names only loses the memo.
  const seenTokens = new Set<string>();
  const fresh = (selectors: readonly string[]): readonly string[] => {
    const out: string[] = [];
    for (const s of selectors) {
      if (handed.has(s)) continue;
      handed.add(s);
      out.push(s);
    }
    return out;
  };
  const always = fresh(packs.flatMap((d: GenericData) => d.always.map((i) => d.selectors[i] ?? '')).filter((s) => s !== ''));
  const seenClasses = new Set<string>();
  const match = (tokens: Iterable<string>): readonly string[] => {
    const found: string[] = [];
    for (const token of tokens) {
      if (seenTokens.has(token)) continue;
      if (seenTokens.size < MAX_SEEN_TOKENS) seenTokens.add(token);
      for (const d of packs) found.push(...lookupToken(d, token));
    }
    return fresh(found);
  };
  const matchElement = (id: unknown, classes: unknown): readonly string[] => {
    if (typeof classes !== 'string' || !seenClasses.has(classes)) {
      if (typeof classes === 'string' && seenClasses.size < MAX_SEEN_CLASSES) seenClasses.add(classes);
      return match(tokensOf(id, classes));
    }
    return typeof id === 'string' && id !== '' ? match([`#${id}`]) : [];
  };
  return { always, match, matchElement };
}

/**
 * The id and class tokens of one element from its `id` and `class` attribute values, in
 * `leadingToken`'s form (`#id`, `.class`). Attribute strings, never `element.id` / `classList`: a form's
 * named controls can shadow those properties (DOM clobbering, security review MEDIUM-1).
 */
export function tokensOf(id: unknown, classes: unknown): readonly string[] {
  const out: string[] = [];
  if (typeof id === 'string' && id !== '') out.push(`#${id}`);
  if (typeof classes === 'string') for (const c of classes.split(/[\t\n\f\r ]+/)) if (c !== '') out.push(`.${c}`);
  return out;
}
