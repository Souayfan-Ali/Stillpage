/**
 * The eligibility gate E1–E11 (update-strategy notes §3.3, testing notes §4, P2-02): a pure function over the base and
 * candidate zips, the release record, the ledgers, the regex answers and the results of the two
 * effectful checks (E9 Chromium load, E11 store state), which the caller runs and passes in. A ruleset
 * release is published only when every check passes; otherwise the strongest failure action wins:
 * abort > route-to-full > open-pr > skip.
 */
import { manifestOf } from '../release/manifest.js';
import { readZip } from '../release/zip.js';
import { checkE1, checkE2, checkE3, checkE4, checkE5, type Unpacked } from './files.js';
import { checkE10, checkE6, checkE7, checkE8 } from './rules.js';
import { result, type CheckResult, type GateAction, type GateInput, type GateVerdict, type LoadReport, type StoreState } from './types.js';

const SEVERITY: readonly GateAction[] = ['abort', 'route-to-full', 'open-pr', 'skip'];

function unpack(bytes: Uint8Array): Unpacked {
  const entries = readZip(bytes);
  return { bytes, entries: new Map(entries.map((e) => [e.path, e])), manifest: manifestOf(entries) };
}

/** E9: the caller's load run (unpacked load with the default rulesets, DNR tables, smoke corpus). */
function checkE9(load: LoadReport | undefined): CheckResult {
  if (load === undefined) return result('E9', 'abort', ['E9 was not run']);
  return result('E9', 'abort', load.ok ? [] : load.problems.length > 0 ? load.problems : ['load failed']);
}

/** E11: item published, no warning, no pending submission (update-strategy notes §3.5: R pauses while F is in review). */
function checkE11(store: StoreState | undefined): CheckResult {
  if (store === undefined) return result('E11', 'skip', ['store state unknown']);
  return result('E11', 'skip', [
    ...(store.published ? [] : ['item is not published']),
    ...(store.warned ? ['item carries a warning'] : []),
    ...(store.pendingSubmission ? ['a submission is pending'] : []),
  ]);
}

/** Runs every check; never throws on a bad candidate (an unreadable zip is an abort). */
export function runGate(input: GateInput): GateVerdict {
  let base: Unpacked;
  let candidate: Unpacked;
  try {
    base = unpack(input.base);
    candidate = unpack(input.candidate);
  } catch (e) {
    const problem = `unreadable zip: ${e instanceof Error ? e.message : String(e)}`;
    return { outcome: 'abort', checks: [result('E1', 'abort', [problem])] };
  }
  const checks = [
    checkE1(base, input.record, input.store), checkE2(base, candidate), checkE3(base, candidate), checkE4(base, candidate),
    checkE5(base, candidate), checkE6(base, candidate), checkE7(base, input.ledgers), checkE8(candidate, input.regexSupported),
    checkE9(input.load), checkE10(base, candidate), checkE11(input.store),
  ];
  const failed = new Set(checks.filter((c) => !c.pass).map((c) => c.action));
  return { outcome: SEVERITY.find((a) => failed.has(a)) ?? 'publish', checks };
}
