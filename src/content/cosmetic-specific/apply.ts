/**
 * `cosmetic-specific` (P1-34, cosmetic notes §2.1): the applier registered last in every ISOLATED shard
 * registration. It takes the inline shard data its registration pushed, looks the frame's host and its
 * parents up, and adopts one constructed stylesheet: stock selectors only with
 * `display:none!important`, `:style()` rules re-sanitised here (security notes §4). Rules are inserted one at
 * a time inside `try/catch`, so one rule Chrome refuses never swallows the rest. No storage read, no
 * message — except the CSS fallback (P1-38) in a frame without `adoptedStyleSheets`, which names the
 * registration only, never selector text. No work at module top level.
 */
import { frameHost, type FrameLocation } from '../../core/content/frame.js';
import { takeQueue } from '../../core/content/guard.js';
import { lookupHost, SHARD_QUEUE, type ShardData } from '../../core/content/shard-data.js';
import type { Hostname } from '../../core/ids.js';
import { hideRule, styleRule } from '../../core/sanitise/selector.js';

/** The part of `CSSStyleSheet` used here. */
export interface SheetLike {
  insertRule(rule: string, index: number): number;
  readonly cssRules: { readonly length: number };
}

/** The part of `Document` used here; `adoptedStyleSheets` may be missing (P1-38). */
export interface AdoptTarget {
  adoptedStyleSheets?: readonly unknown[];
}

/** Every rule for `host` across `shards`: hide rules first, then `:style()` rules; de-duplicated. */
export function cssRulesFor(shards: readonly ShardData[], host: Hostname): readonly string[] {
  const hide = new Set<string>();
  const style = new Set<string>();
  for (const d of shards) {
    const found = lookupHost(d, host);
    for (const i of found.selectors) {
      const rule = hideRule(d.selectors[i] ?? '');
      if (rule !== null) hide.add(rule);
    }
    for (const i of found.styles) {
      const [selector = '', declarations = ''] = d.styles[i] ?? [];
      const rule = styleRule(selector, declarations);
      if (rule !== null) style.add(rule);
    }
  }
  return [...hide, ...style];
}

/** Inserts `rules` one by one into a new sheet and adopts it. `false` when the document cannot adopt. */
export function adoptRules(doc: AdoptTarget, rules: readonly string[], newSheet: () => SheetLike): boolean {
  const current = doc.adoptedStyleSheets;
  if (!Array.isArray(current)) return false;
  const sheet = newSheet();
  for (const rule of rules) {
    try {
      sheet.insertRule(rule, sheet.cssRules.length);
    } catch {
      // Chrome refused this rule (e.g. a pseudo-class it does not know); the others still apply.
    }
  }
  doc.adoptedStyleSheets = [...(current as readonly unknown[]), sheet];
  return true;
}

export interface ApplierEnv {
  /** The isolated world's global, which holds the data queue. */
  readonly scope: object;
  readonly document: AdoptTarget;
  readonly location: FrameLocation;
  readonly newSheet: () => SheetLike;
  /** Asks the worker to insert the CSS of one registration (`cs/cssFallback`). */
  readonly fallback: (registration: string) => void;
}

/** Runs once per injection; returns the number of rules it applied or asked for. */
export function runCosmeticSpecific(env: ApplierEnv): number {
  const { shards } = takeQueue(env.scope, SHARD_QUEUE.ISOLATED);
  const host = frameHost(env.location);
  if (host === null || shards.length === 0) return 0;
  const rules = cssRulesFor(shards, host);
  if (rules.length === 0) return 0;
  if (adoptRules(env.document, rules, env.newSheet)) return rules.length;
  for (const d of shards) {
    if (cssRulesFor([d], host).length > 0) env.fallback(`iso:${d.pack}:${String(d.shard)}`);
  }
  return rules.length;
}
