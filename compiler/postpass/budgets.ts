/**
 * Budgets and the growth guard (filter-pipeline notes §6.6, §8; P1-25). Absolute budgets fail the build; growth of
 * more than 10 % against the previous build is reported (the daily workflow then opens a pull request
 * instead of publishing). Slot ceilings come from `lists.config.json`; the project-wide ceilings from
 * `src/core/limits.ts`.
 */
import { z } from 'zod';
import {
  DEFAULT_REGEX_BUDGET, DEFAULT_RULE_BUDGET, MAX_RULESET_FILE_BYTES, NON_REGIONAL_REGEX_BUDGET, NON_REGIONAL_RULE_BUDGET,
  RULESET_SLOTS, STATIC_REGEX_POOL,
} from '../../src/core/limits.js';
import type { ListsConfig, SlotBudget } from '../config/schema.js';
import { DnrRuleSchema, type DnrRule } from '../dnr/schema.js';

/** Growth above this share of the previous count is reported for review (filter-pipeline notes §6.6). */
const GROWTH_LIMIT = 0.1;

/** One declared ruleset slot (a file in `rule_resources`). */
export interface Slot {
  readonly id: string;
  /** The config ruleset (or `popups`) it belongs to. */
  readonly ruleset: string;
  readonly pack: string;
  readonly unsafe: boolean;
  readonly budget: SlotBudget;
  readonly isDefault: boolean;
  readonly regional: boolean;
}

export interface SlotCount {
  readonly rules: number;
  readonly regex: number;
  readonly bytes: number;
}

/** Every slot the config declares, in config order (popups last). */
export function slotsOf(config: ListsConfig): readonly Slot[] {
  const isDefault = (pack: string): boolean => config.packs[pack]?.default ?? false;
  const fromRulesets = config.rulesets.flatMap((r) => {
    const base = { ruleset: r.id, pack: r.pack, isDefault: isDefault(r.pack), regional: r.category === 'regional' };
    return [
      ...(r.slots.safe ? [{ ...base, id: r.id, unsafe: false, budget: r.slots.safe }] : []),
      ...(r.slots.unsafe ? [{ ...base, id: `${r.id}-x`, unsafe: true, budget: r.slots.unsafe }] : []),
    ];
  });
  const p = config.popups;
  return [...fromRulesets, { id: p.id, ruleset: p.id, pack: p.pack, unsafe: false, budget: p.budget, isDefault: isDefault(p.pack), regional: false }];
}

const sum = (slots: readonly Slot[], f: (s: Slot) => number): number => slots.reduce((n, s) => n + f(s), 0);
const over = (what: string, value: number, max: number): string[] => (value > max ? [`${what}: ${String(value)} > ${String(max)}`] : []);

/** Problems with the ceilings themselves (they must fit Chrome's limits together). */
export function ceilingProblems(slots: readonly Slot[], expectedSlots = RULESET_SLOTS): readonly string[] {
  const defaults = slots.filter((s) => s.isDefault);
  const nonRegional = slots.filter((s) => !s.regional);
  return [
    ...(slots.length === expectedSlots ? [] : [`${String(slots.length)} ruleset slots declared, expected ${String(expectedSlots)}`]),
    ...over('default rule ceilings', sum(defaults, (s) => s.budget.rules), DEFAULT_RULE_BUDGET),
    ...over('default regex ceilings', sum(defaults, (s) => s.budget.regex), DEFAULT_REGEX_BUDGET),
    ...over('non-regional rule ceilings', sum(nonRegional, (s) => s.budget.rules), NON_REGIONAL_RULE_BUDGET),
    ...over('non-regional regex ceilings', sum(nonRegional, (s) => s.budget.regex), NON_REGIONAL_REGEX_BUDGET),
    ...over('regex ceilings of every slot enabled together', sum(slots, (s) => s.budget.regex), STATIC_REGEX_POOL),
  ];
}

/** Problems with this build's counts; `counts` has one entry per slot. */
export function countProblems(slots: readonly Slot[], counts: ReadonlyMap<string, SlotCount>): readonly string[] {
  const of = (s: Slot): SlotCount => counts.get(s.id) ?? { rules: 0, regex: 0, bytes: 0 };
  const defaults = slots.filter((s) => s.isDefault);
  return [
    ...[...counts.keys()].filter((id) => !slots.some((s) => s.id === id)).map((id) => `rules for undeclared slot "${id}"`),
    ...slots.filter((s) => !counts.has(s.id)).map((s) => `slot "${s.id}" was not built`),
    ...slots.flatMap((s) => [
      ...over(`${s.id} rules`, of(s).rules, s.budget.rules),
      ...over(`${s.id} regex`, of(s).regex, s.budget.regex),
      ...over(`${s.id} file bytes`, of(s).bytes, MAX_RULESET_FILE_BYTES),
    ]),
    ...over('default rules', sum(defaults, (s) => of(s).rules), DEFAULT_RULE_BUDGET),
    ...over('default regex', sum(defaults, (s) => of(s).regex), DEFAULT_REGEX_BUDGET),
    ...over('regex of every slot enabled together', sum(slots, (s) => of(s).regex), STATIC_REGEX_POOL),
  ];
}

/** Fails the build with every budget problem found. */
export function assertBudgets(slots: readonly Slot[], counts: ReadonlyMap<string, SlotCount>, expectedSlots = RULESET_SLOTS): void {
  const problems = [...ceilingProblems(slots, expectedSlots), ...countProblems(slots, counts)];
  if (problems.length > 0) throw new Error(`over budget:\n  ${problems.join('\n  ')}`);
}

/** Counts of one slot's emitted rules; `bytes` is the length of its file text. */
export function countSlot(rules: readonly DnrRule[], text: string): SlotCount {
  return { rules: rules.length, regex: rules.filter((r) => r.condition.regexFilter !== undefined).length, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Throws on any key Chrome does not document (static files would ignore it silently, S-07). */
export function assertKnownKeys(slot: string, rules: readonly DnrRule[]): void {
  for (const r of rules) {
    const parsed = DnrRuleSchema.safeParse(r);
    if (!parsed.success) throw new Error(`${slot} rule ${String(r.id)}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
}

export const CountsFileSchema = z.strictObject({
  schema: z.literal(1),
  slots: z.record(z.string(), z.strictObject({ rules: z.number().int().min(0), regex: z.number().int().min(0) })),
});
export type CountsFile = z.infer<typeof CountsFileSchema>;

export interface Growth {
  readonly slot: string;
  readonly before: number;
  readonly after: number;
  /** Relative change of the rule count; `Infinity` for a slot that was empty. */
  readonly change: number;
}

/** Slots whose rule count moved by more than `GROWTH_LIMIT` either way since `previous`. */
export function growthReport(previous: CountsFile | undefined, counts: ReadonlyMap<string, SlotCount>): readonly Growth[] {
  if (previous === undefined) return [];
  return [...counts].flatMap(([slot, c]) => {
    const before = previous.slots[slot]?.rules ?? 0;
    if (before === c.rules) return [];
    const change = before === 0 ? Number.POSITIVE_INFINITY : (c.rules - before) / before;
    return Math.abs(change) > GROWTH_LIMIT ? [{ slot, before, after: c.rules, change }] : [];
  });
}

/** The counts file the next build compares against (sorted, trailing newline). */
export function serialiseCounts(counts: ReadonlyMap<string, SlotCount>): string {
  const slots = Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, c]) => [id, { rules: c.rules, regex: c.regex }]));
  return `${JSON.stringify({ schema: 1, slots }, null, 2)}\n`;
}

/**
 * Counts to write after building a subset of the slots (D-125): the built ones, plus the previous figures
 * of `carried` slots, so a `--drop-pending` build keeps the growth baseline of what it skipped. A carried
 * slot without previous figures adds nothing; `bytes` is not stored in the counts file, so it is 0.
 */
export function withCarriedCounts(built: ReadonlyMap<string, SlotCount>, previous: CountsFile | undefined, carried: readonly string[]): ReadonlyMap<string, SlotCount> {
  const kept = carried.flatMap((id) => {
    const c = previous?.slots[id];
    return c === undefined || built.has(id) ? [] : [[id, { rules: c.rules, regex: c.regex, bytes: 0 }] as const];
  });
  return new Map([...built, ...kept]);
}
