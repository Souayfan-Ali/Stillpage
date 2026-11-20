/**
 * Overrides (update-strategy notes §8, P2-08): `lists/overrides/overrides.json` is the only place we alter upstream
 * behaviour. Every entry is dated, has an owner and an https link, lives at most 90 days, and fails the
 * build once expired (never dropped silently: that would bring the breakage back). Kind `network` only: one
 * exception (`@@…`) or `$badfilter` line, so an override can only loosen. Entries join their ruleset's
 * list entries before normalisation and conversion; `$badfilter` lines join the build-wide set.
 * Not built (D-30): the `user-origin-css: <host>` kind, added with the first real host that needs it.
 */
import type { NetworkRule } from '@adguard/agtree';
import { z } from 'zod';
import { parseJsonWith } from '../config/load.js';
import { collectBadfilters, filterKey, isBadfilter } from '../normalise/badfilter.js';
import { hasMod } from '../normalise/modifiers.js';
import { classify } from '../parse/classify.js';
import type { Entry } from '../parse/parse-list.js';

const OVERRIDES_SCHEMA = 1;
/** Longest life of an entry; renewal is a reviewed change of `added` and `expires`. */
const MAX_LIFE_DAYS = 90;
/** Warn this many days before expiry: an expired entry stops the daily ruleset run for everyone. */
const WARN_DAYS = 14;
const MS_PER_DAY = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Source list id of override entries in logs and reports. */
const OVERRIDES_LIST = 'overrides';

const isoDay = z.string().regex(ISO_DAY).refine((d) => new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'not a calendar day');

const EntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  kind: z.literal('network'),
  ruleset: z.string().min(1),
  filter: z.string().min(1).max(2048),
  reason: z.string().min(1),
  owner: z.string().min(1),
  link: z.url({ protocol: /^https$/ }),
  added: isoDay,
  expires: isoDay,
});
const OverridesFileSchema = z.strictObject({ schema: z.literal(OVERRIDES_SCHEMA), entries: z.array(EntrySchema) });
export type OverrideEntry = z.infer<typeof EntrySchema>;
export type OverridesFile = z.infer<typeof OverridesFileSchema>;

export interface OverrideCheck {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Parses and schema-checks the file text (`what` names it in errors). */
export const parseOverrides = (text: string, what: string): OverridesFile => parseJsonWith(OverridesFileSchema, text, what);

const days = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY;

/** The filter as a parsed network rule, or why it is not an allowed override. */
function networkRuleOf(filter: string): NetworkRule | string {
  if (/[\r\n]/.test(filter)) return 'filter must be one line';
  const c = classify(filter.trim());
  const node = c.node;
  if (c.kind !== 'network' || node?.category !== 'Network' || node.type !== 'NetworkRule') {
    return 'not a network filter (cosmetic and scriptlet overrides are not supported yet)';
  }
  return node.exception || hasMod(node, 'badfilter') ? node : 'a network override must be an exception (@@) or $badfilter';
}

function dateProblems(e: OverrideEntry, today: string): { errors: string[]; warnings: string[] } {
  const life = days(e.added, e.expires);
  const left = days(today, e.expires);
  return {
    errors: [
      ...(left < 0 ? [`${e.id}: expired on ${e.expires}`] : []),
      ...(life < 0 ? [`${e.id}: expires before it was added`] : []),
      ...(life > MAX_LIFE_DAYS ? [`${e.id}: lives ${String(life)} days (at most ${String(MAX_LIFE_DAYS)}; renew by a reviewed change)`] : []),
    ],
    warnings: left >= 0 && left < WARN_DAYS ? [`${e.id}: expires on ${e.expires} (renew or remove it)`] : [],
  };
}

/** Validates every entry against `today` (ISO day, UTC) and the known ruleset ids. */
export function checkOverrides(file: OverridesFile, ctx: { readonly today: string; readonly rulesets: ReadonlySet<string> }): OverrideCheck {
  const seen = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const e of file.entries) {
    if (seen.has(e.id)) errors.push(`${e.id}: id used twice`);
    seen.add(e.id);
    if (!ctx.rulesets.has(e.ruleset)) errors.push(`${e.id}: unknown ruleset "${e.ruleset}"`);
    const rule = networkRuleOf(e.filter);
    if (typeof rule === 'string') errors.push(`${e.id}: ${rule}`);
    const d = dateProblems(e, ctx.today);
    errors.push(...d.errors);
    warnings.push(...d.warnings);
  }
  return { errors, warnings };
}

const entryOf = (e: OverrideEntry, index: number): Entry =>
  ({ ...classify(e.filter.trim()), source: { list: OVERRIDES_LIST, line: index + 1, text: `${e.id}: ${e.filter.trim()}` }, trusted: false });

/** Ruleset id → override entries, as list entries (call after `checkOverrides` passed). */
export function overrideEntries(file: OverridesFile): ReadonlyMap<string, readonly Entry[]> {
  const out = new Map<string, Entry[]>();
  file.entries.forEach((e, i) => { out.set(e.ruleset, [...(out.get(e.ruleset) ?? []), entryOf(e, i)]); });
  return out;
}

/** Warnings for override `$badfilter` entries that cancel no filter of `upstream` (fixed upstream: remove the entry). */
export function deadBadfilters(overrides: ReadonlyMap<string, readonly Entry[]>, upstream: readonly Entry[]): readonly string[] {
  const keys = new Set(upstream.flatMap((u) => (u.node?.category === 'Network' && u.node.type === 'NetworkRule' && !isBadfilter(u) ? [filterKey(u.node)] : [])));
  return [...overrides.values()].flat()
    .filter((entry) => isBadfilter(entry) && ![...collectBadfilters([entry])].some((k) => keys.has(k)))
    .map((entry) => `override ${entry.source.text.split(':')[0] ?? ''}: $badfilter matches no upstream filter (fixed upstream? remove the entry)`);
}
