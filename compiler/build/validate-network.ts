/**
 * The validation step applied to compiled rulesets (P1-23): collect every regex query, then drop
 * and log what Chromium refuses and every rule shape it cannot index. The redirect invariant of
 * P1-22 is checked again afterwards, because dropping a block may uncover its redirect.
 */
import { assertRedirectsCovered, uncoveredRedirects } from '../postpass/split.js';
import { queryOf, type RegexAnswer, type RegexQuery } from '../validate/regex.js';
import { validateRules } from '../validate/validate.js';
import type { NetworkRuleset } from './network.js';

/** Every regex query of `rulesets`, in rule order. */
export function regexQueries(rulesets: readonly { readonly safe: NetworkRuleset['safe']; readonly unsafe: NetworkRuleset['unsafe'] }[]): readonly RegexQuery[] {
  return rulesets.flatMap((r) => [...r.safe, ...r.unsafe]).flatMap((r) => {
    const q = queryOf(r.rule);
    return q === undefined ? [] : [q];
  });
}

/** The rulesets with refused rules removed and logged. */
export function validateNetwork(rulesets: readonly NetworkRuleset[], answers: ReadonlyMap<string, RegexAnswer>): readonly NetworkRuleset[] {
  return rulesets.map((r) => {
    const safe = validateRules(r.safe, answers);
    const unsafe = validateRules(r.unsafe, answers);
    const orphans = new Set(uncoveredRedirects(safe.kept, unsafe.kept));
    const kept = unsafe.kept.filter((x) => !orphans.has(x));
    assertRedirectsCovered(r.config.id, safe.kept, kept);
    const orphanLog = [...orphans].flatMap((x) => x.sources.map((s) => ({ source: s.source, reason: 'redirect-uncovered' as const })));
    return { ...r, safe: safe.kept, unsafe: kept, log: [...r.log, ...safe.log, ...unsafe.log, ...orphanLog] };
  });
}
