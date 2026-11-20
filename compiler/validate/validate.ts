/**
 * The validation step of the post-pass (filter-pipeline notes §6.5, P1-23): every rule is checked for the shapes
 * that stop an extension from loading, and every regex against Chromium's answer. Failing rules are
 * dropped and logged once per source filter; a regex Chromium was never asked about fails the build.
 */
import type { LogEntry } from '../normalise/normalise.js';
import type { ReasonCode } from '../normalise/reasons.js';
import type { BucketedRule } from '../postpass/coalesce.js';
import { queryKey, queryOf, type RegexAnswer } from './regex.js';
import { shapeProblem } from './shape.js';

export interface ValidatedRules {
  readonly kept: readonly BucketedRule[];
  readonly log: readonly LogEntry[];
}

function problemOf(r: BucketedRule, answers: ReadonlyMap<string, RegexAnswer>): { reason: ReasonCode; detail: string } | undefined {
  const shape = shapeProblem(r.rule);
  if (shape !== undefined) return { reason: 'invalid-rule-shape', detail: shape };
  const q = queryOf(r.rule);
  if (q === undefined) return undefined;
  const answer = answers.get(queryKey(q));
  if (answer === undefined) throw new Error(`no Chromium answer for regex ${JSON.stringify(q.regex)}`);
  return answer.isSupported ? undefined : { reason: 'regex-unsupported', detail: answer.reason ?? 'unsupported' };
}

/** Keeps the rules Chromium accepts. Pure. */
export function validateRules(rules: readonly BucketedRule[], answers: ReadonlyMap<string, RegexAnswer>): ValidatedRules {
  const kept: BucketedRule[] = [];
  const log: LogEntry[] = [];
  for (const r of rules) {
    const problem = problemOf(r, answers);
    if (problem === undefined) kept.push(r);
    else log.push(...r.sources.map((s) => ({ source: s.source, ...problem })));
  }
  return { kept, log };
}
