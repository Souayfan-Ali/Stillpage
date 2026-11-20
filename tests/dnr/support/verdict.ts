/**
 * Table rows for the DNR suites (testing notes §5) and their verdicts from `testMatchOutcome`. A verdict
 * is the action of the rule that decides the request: `block`, `redirect`, `allow` (also
 * `allowAllRequests`), `upgrade`, `headers` (only `modifyHeaders` matched) or `none`. Rules are looked
 * up by ruleset and id in the rules the test loaded, so a verdict names its rule.
 */
import type { Worker } from '@playwright/test';

export type Verdict = 'block' | 'redirect' | 'allow' | 'upgrade' | 'headers' | 'none' | 'error';
/** What a row expects: an exact verdict, or `stop` (block or redirect) / `pass` (anything else). */
export type Expectation = Exclude<Verdict, 'error'> | 'stop' | 'pass';

/** A request as `testMatchOutcome` takes it (no tab: `tabId: -1`, the default). */
export interface DnrRequest {
  readonly url: string;
  readonly type: string;
  readonly initiator?: string;
  readonly method?: string;
  /** A hypothetical tab, for tab-scoped session rules (D-55a "Proceed once"). */
  readonly tabId?: number;
}

export interface DnrCase extends DnrRequest {
  readonly expect: Expectation;
  /** The filter or DNR feature this row protects. */
  readonly because: string;
}

export interface Outcome {
  readonly verdict: Verdict;
  /** `ruleset#id:action` of every matched rule, for failure messages. */
  readonly rules: readonly string[];
  /** The rule that decided the verdict, when one did. */
  readonly decidedBy?: Matched;
}

export interface Matched {
  readonly rulesetId: string;
  readonly ruleId: number;
}

type RuleIndex = ReadonlyMap<string, ReadonlyMap<number, string>>;

/** ruleset id → rule id → action type, from the rule files the extension was built with. */
export function indexRules(rulesets: readonly { readonly id: string; readonly rules: readonly object[] }[]): RuleIndex {
  return new Map(
    rulesets.map((r) => [
      r.id,
      new Map((r.rules as readonly { id: number; action: { type: string } }[]).map((rule) => [rule.id, rule.action.type])),
    ]),
  );
}

const ACTION_VERDICT: Readonly<Record<string, Verdict>> = {
  block: 'block',
  redirect: 'redirect',
  allow: 'allow',
  allowAllRequests: 'allow',
  upgradeScheme: 'upgrade',
};

function outcomeOf(matched: readonly Matched[] | { error: string }, index: RuleIndex): Outcome {
  if ('error' in matched) return { verdict: 'error', rules: [matched.error] };
  const actions = matched.map((m) => ({ m, action: index.get(m.rulesetId)?.get(m.ruleId) ?? 'unknown' }));
  const deciding = actions.find((a) => a.action !== 'modifyHeaders');
  const verdict: Verdict = deciding === undefined ? (actions.length > 0 ? 'headers' : 'none') : (ACTION_VERDICT[deciding.action] ?? 'error');
  const rules = actions.map((a) => `${a.m.rulesetId}#${String(a.m.ruleId)}:${a.action}`);
  return deciding === undefined ? { verdict, rules } : { verdict, rules, decidedBy: deciding.m };
}

/** Requests per `evaluate`: bounded batches instead of one 20,000-promise call (review MEDIUM 7). */
const BATCH = 1_000;

async function matchBatch(worker: Worker, requests: readonly object[]): Promise<(readonly Matched[] | { error: string })[]> {
  return worker.evaluate(async (rs) => {
    const d = (globalThis as unknown as { chrome: { declarativeNetRequest: { testMatchOutcome: (r: object) => Promise<{ matchedRules: Matched[] }> } } }).chrome
      .declarativeNetRequest;
    return Promise.all(
      rs.map((r) =>
        d.testMatchOutcome({ tabId: -1, ...r }).then(
          (x) => x.matchedRules,
          (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
        ),
      ),
    );
  }, requests);
}

/** Every case through `testMatchOutcome` in `worker`, in sequential batches. */
export async function outcomes(worker: Worker, cases: readonly DnrRequest[], index: RuleIndex): Promise<readonly Outcome[]> {
  const requests = cases.map((c) => ({
    url: c.url,
    type: c.type,
    ...(c.initiator === undefined ? {} : { initiator: c.initiator }),
    ...(c.method === undefined ? {} : { method: c.method }),
    ...(c.tabId === undefined ? {} : { tabId: c.tabId }),
  }));
  const raw: (readonly Matched[] | { error: string })[] = [];
  for (let start = 0; start < requests.length; start += BATCH) raw.push(...(await matchBatch(worker, requests.slice(start, start + BATCH))));
  return raw.map((m) => outcomeOf(m, index));
}

/** True when `verdict` meets `expected`. */
function meets(verdict: Verdict, expected: Expectation): boolean {
  if (expected === 'stop') return verdict === 'block' || verdict === 'redirect';
  if (expected === 'pass') return verdict !== 'block' && verdict !== 'redirect' && verdict !== 'error';
  return verdict === expected;
}

/** Rows whose verdict does not meet the expectation, as readable lines (empty when all pass). */
export function failures(cases: readonly DnrCase[], got: readonly Outcome[]): readonly string[] {
  return cases.flatMap((c, i) => {
    const o = got[i];
    if (o !== undefined && meets(o.verdict, c.expect)) return [];
    const init = c.initiator === undefined ? '' : ` from ${c.initiator}`;
    return [`${c.type} ${c.url}${init}: expected ${c.expect}, got ${o?.verdict ?? 'nothing'} [${o?.rules.join(', ') ?? ''}] — ${c.because}`];
  });
}
