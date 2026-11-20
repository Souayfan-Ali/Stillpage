/**
 * Regex gate (filter-pipeline notes §6.5, P1-23, ADR-004 condition 4): every `regexFilter` is checked with
 * Chromium's own `declarativeNetRequest.isRegexSupported` (RE2 and the 2 KB memory limit as Chrome
 * applies them), never with re2-wasm. Answers are cached by the SHA-256 of the query and are only
 * valid for the Chromium build that gave them.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DnrRule } from '../dnr/schema.js';

/** The options of `isRegexSupported` a rule needs. */
export interface RegexQuery {
  readonly regex: string;
  readonly isCaseSensitive: boolean;
  /** True for `regexSubstitution` redirects: the regex must have capturing groups Chrome can use. */
  readonly requireCapturing: boolean;
}

const AnswerSchema = z.strictObject({ isSupported: z.boolean(), reason: z.string().optional() });
export type RegexAnswer = z.infer<typeof AnswerSchema>;

export const RegexCacheSchema = z.strictObject({
  schema: z.literal(1),
  /** Identity of the Chromium build that answered (Playwright's bundled revision). */
  chromium: z.string().min(1),
  results: z.record(z.string().regex(/^[0-9a-f]{64}$/), AnswerSchema),
});
export type RegexCache = z.infer<typeof RegexCacheSchema>;

/** The port to a real Chromium (`compiler/chromium/node-ports.ts`); a fake in unit tests. */
export interface RegexChecker {
  readonly id: string;
  readonly check: (queries: readonly RegexQuery[]) => Promise<readonly RegexAnswer[]>;
}

export const emptyRegexCache = (chromium: string): RegexCache => ({ schema: 1, chromium, results: {} });

/** The query for a rule's regex, or undefined for a rule without one. */
export function queryOf(rule: DnrRule): RegexQuery | undefined {
  const regex = rule.condition.regexFilter;
  if (regex === undefined) return undefined;
  return {
    regex,
    isCaseSensitive: rule.condition.isUrlFilterCaseSensitive ?? false,
    requireCapturing: rule.action.redirect?.regexSubstitution !== undefined,
  };
}

/** Stable cache key of a query. */
export const queryKey = (q: RegexQuery): string =>
  createHash('sha256').update(JSON.stringify([q.regex, q.isCaseSensitive, q.requireCapturing]), 'utf8').digest('hex');

export interface ResolvedRegexes {
  /** Query key → Chromium's answer, for every query asked. */
  readonly answers: ReadonlyMap<string, RegexAnswer>;
  /** The cache with the new answers added (results sorted by key). */
  readonly cache: RegexCache;
  /** How many queries went to Chromium (0 when the cache answered everything). */
  readonly asked: number;
}

/** Answers every query, asking `checker` only for those the cache (of the same Chromium) lacks. */
export async function resolveRegexes(queries: readonly RegexQuery[], cache: RegexCache, checker: RegexChecker): Promise<ResolvedRegexes> {
  const known = cache.chromium === checker.id ? cache.results : {};
  const unique = new Map(queries.map((q) => [queryKey(q), q]));
  const missing = [...unique].filter(([key]) => !Object.hasOwn(known, key));
  const answered = missing.length === 0 ? [] : await checker.check(missing.map(([, q]) => q));
  if (answered.length !== missing.length) throw new Error(`Chromium answered ${String(answered.length)} of ${String(missing.length)} regex queries`);
  const fresh = Object.fromEntries(missing.map(([key], i) => [key, AnswerSchema.parse(answered[i])]));
  const results = Object.fromEntries(Object.entries({ ...known, ...fresh }).sort(([a], [b]) => (a < b ? -1 : 1)));
  const answers = new Map([...unique.keys()].map((key): [string, RegexAnswer] => [key, results[key] ?? { isSupported: false }]));
  return { answers, cache: { schema: 1, chromium: checker.id, results }, asked: missing.length };
}
