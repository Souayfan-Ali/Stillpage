/**
 * Differential suite vs uBO Lite (P1-45 — PARTIAL for now; testing notes §5, ADR-004 conditions 1–2): the
 * fixed-seed corpus (`differential/corpus.ts`, ≥ 20,000 rule-derived and benign requests) through
 * `testMatchOutcome` in uBOL's published release (static + its dynamic and session rules, `pgl` off) and
 * in our compiled default rulesets from `public/` (`-x` on), both in one launch. Gates: ≥ 99 %
 * identical verdicts without the one allow-listed class (`main_frame` strict blocking), raw figure
 * reported beside it; ≥ 99.9 % outside `main_frame`; every difference explained by a class of the
 * checked-in allowlist. Our `popups` ruleset is left out: uBOL has no DNR counterpart (S-02c), and the
 * pop-up DNR suite covers it. The report goes to `dist/differential/report.json`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { classify, DIFFERENCE_CLASSES, type Difference, type RuleFacts } from './differential/allowlist.js';
import { buildCorpus, corpusHash, SEED, type CorpusRequest } from './differential/corpus.js';
import { expectNoSurvivors } from './helpers.js';
import { compiledRulesets } from './support/compiled.js';
import { withExtensions, type TestRuleset } from './support/launch.js';
import { settleUbol, ubolRelease } from './support/ubol.js';
import { indexRules, outcomes, type Matched, type Outcome, type Verdict } from './support/verdict.js';

const MIN_REQUESTS = 20_000;
const GATE_ADJUSTED = 0.99;
const GATE_OUTSIDE_MAIN_FRAME = 0.999;
const LAUNCH_TIMEOUT_MS = 300_000;
const REPORT = path.resolve(import.meta.dirname, '../../dist/differential/report.json');
const SAMPLE_PER_CLASS = 20;
const PERCENT = 100;
const DECIMALS = 3;

/** Ceiling on the excluded strict-block class, so a growing exclusion cannot lift the adjusted figure. */
const MAX_EXCLUDED_SHARE = 0.025;

let ubol: ReturnType<typeof ubolRelease>;
let ours: readonly TestRuleset[];
let corpus: readonly CorpusRequest[];

interface Compared {
  readonly request: CorpusRequest;
  readonly ubol: Outcome;
  readonly ours: Outcome;
  readonly difference: Difference | null;
}

let compared: readonly Compared[];

type RuleMap = ReadonlyMap<string, RuleFacts>;

const key = (m: Matched | undefined): string => (m === undefined ? '' : `${m.rulesetId}#${String(m.ruleId)}`);

/** `ruleset#id` → rule, to look at the rule that decided a verdict. */
function ruleMap(sets: readonly TestRuleset[]): RuleMap {
  return new Map(sets.flatMap((s) => (s.rules as (RuleFacts & { id: number })[]).map((r) => [`${s.id}#${String(r.id)}`, r] as const)));
}

function at(list: readonly Outcome[], i: number): Outcome {
  const item = list[i];
  if (item === undefined) throw new Error(`no outcome for request ${String(i)}`);
  return item;
}

/** S-02c's verdict: a lone `modifyHeaders` match passes like no match (it neither stops nor allows). */
const verdictOf = (o: Outcome): Verdict => (o.verdict === 'headers' ? 'none' : o.verdict);

function compare(request: CorpusRequest, u: Outcome, o: Outcome, rules: { ubol: RuleMap; ours: RuleMap }): Compared {
  const [ubolVerdict, ourVerdict] = [verdictOf(u), verdictOf(o)];
  if (ubolVerdict === ourVerdict) return { request, ubol: u, ours: o, difference: null };
  const ubolRule = rules.ubol.get(key(u.decidedBy)) ?? null;
  const difference: Difference = {
    type: request.type,
    url: request.url,
    ubol: ubolVerdict,
    ours: ourVerdict,
    ubolStrictBlock: JSON.stringify(ubolRule?.action.redirect ?? {}).includes('strictblock'),
    ubolRule,
    ourRule: rules.ours.get(key(o.decidedBy)) ?? null,
  };
  return { request, ubol: u, ours: o, difference };
}

beforeAll(async () => {
  // Inside the hook, so a missing uBOL release or `public/` build fails with its message, not at import.
  ubol = ubolRelease();
  ours = compiledRulesets().filter((r) => r.id !== 'popups');
  corpus = buildCorpus(ubol.rulesets, ours);
  compared = await withExtensions(
    [{ name: 'ours', rulesets: ours, hostAccess: true }],
    async (w) => {
      const ubolWorker = w.get('ubol');
      const ourWorker = w.get('ours');
      if (ubolWorker === undefined || ourWorker === undefined) throw new Error('an extension did not start');
      const ubolSets = [...ubol.rulesets, ...(await settleUbol(ubolWorker))];
      const u = await outcomes(ubolWorker, corpus, indexRules(ubolSets));
      const o = await outcomes(ourWorker, corpus, indexRules(ours));
      const rules = { ubol: ruleMap(ubolSets), ours: ruleMap(ours) };
      return corpus.map((request, i) => compare(request, at(u, i), at(o, i), rules));
    },
    ubol.extension,
  );
  await writeReport();
}, LAUNCH_TIMEOUT_MS);

afterAll(() => {
  expectNoSurvivors();
});

const share = (part: number, whole: number): number => (whole === 0 ? 1 : part / whole);
const pct = (x: number): number => Number((x * PERCENT).toFixed(DECIMALS));

function figures(): Record<string, number> {
  const all = compared.length;
  const same = compared.filter((c) => c.difference === null).length;
  const excluded = compared.filter((c) => c.difference !== null && classify(c.difference)?.excludedFromGate === true).length;
  const outside = compared.filter((c) => c.request.type !== 'main_frame');
  const outsideSame = outside.filter((c) => c.difference === null).length;
  return {
    requests: all,
    identical: same,
    rawAgreement: share(same, all),
    excludedStrictBlock: excluded,
    adjustedAgreement: share(same, all - excluded),
    outsideMainFrame: outside.length,
    outsideMainFrameAgreement: share(outsideSame, outside.length),
  };
}

function byClass(): Record<string, { count: number; sample: readonly object[] }> {
  const ids = [...DIFFERENCE_CLASSES.map((c) => c.id), 'unexplained'];
  return Object.fromEntries(
    ids.map((id) => {
      const rows = compared.filter((c) => c.difference !== null && (classify(c.difference)?.id ?? 'unexplained') === id);
      const sample = rows.slice(0, SAMPLE_PER_CLASS).map((c) => ({ ...c.request, ubol: c.ubol, ours: c.ours }));
      return [id, { count: rows.length, sample }];
    }),
  );
}

async function writeReport(): Promise<void> {
  const f = figures();
  const pairs = compared.reduce<Record<string, number>>((m, c) => {
    if (c.difference === null) return m;
    const k = `${c.request.type === 'main_frame' ? 'main_frame ' : ''}${c.difference.ubol}→${c.difference.ours}`;
    return { ...m, [k]: (m[k] ?? 0) + 1 };
  }, {});
  const report = {
    seed: SEED,
    corpusSha256: corpusHash(corpus),
    ubolVersion: ubol.version,
    ourRulesets: ours.map((r) => `${r.id}:${String(r.rules.length)}`),
    percent: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, k.endsWith('Agreement') ? pct(v) : v])),
    bySource: compared.reduce<Record<string, number>>((m, c) => ({ ...m, [c.request.source]: (m[c.request.source] ?? 0) + 1 }), {}),
    pairs,
    headerOnlyDifferences: compared.filter((c) => c.difference === null && c.ubol.verdict !== c.ours.verdict).length,
    classes: byClass(),
    errors: compared.filter((c) => c.ubol.verdict === 'error' || c.ours.verdict === 'error').map((c) => ({ ...c.request, ubol: c.ubol, ours: c.ours })),
  };
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, `${JSON.stringify(report, null, 1)}\n`);
}

describe('differential vs uBO Lite (P1-45, fixed-seed corpus)', () => {
  test('the corpus has at least 20,000 requests and is the same on every build from the same rules', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(MIN_REQUESTS);
    expect(corpusHash(buildCorpus(ubol.rulesets, ours))).toBe(corpusHash(corpus));
    expect(compared.filter((c) => c.ubol.verdict === 'error' || c.ours.verdict === 'error')).toEqual([]);
  });

  test('the excluded strict-block class stays under its ceiling', () => {
    expect(figures()['excludedStrictBlock'] ?? Infinity).toBeLessThanOrEqual(MAX_EXCLUDED_SHARE * corpus.length);
  });

  test('every class with a ceiling stays under it', () => {
    const counts = byClass();
    const over = DIFFERENCE_CLASSES.filter((c) => c.ceiling !== undefined && (counts[c.id]?.count ?? 0) > c.ceiling).map((c) => c.id);
    expect(over).toEqual([]);
  });

  test('every verdict difference is explained by a class of the allowlist', () => {
    expect(byClass()['unexplained']?.sample ?? []).toEqual([]);
  });

  test('≥ 99 % identical verdicts without the main_frame strict-block class (raw figure in the report)', () => {
    expect(figures()['adjustedAgreement']).toBeGreaterThanOrEqual(GATE_ADJUSTED);
  });

  test('≥ 99.9 % identical verdicts outside main_frame', () => {
    expect(figures()['outsideMainFrameAgreement']).toBeGreaterThanOrEqual(GATE_OUTSIDE_MAIN_FRAME);
  });
});
