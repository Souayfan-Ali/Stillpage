import { describe, expect, test } from 'vitest';
import { aggregate, toMarkdown, WOULD_BLOCK_TARGET_PER_500 } from '../../../bench/shadow/aggregate.js';
import { type Decision, LOG_ATTRIBUTE, LOG_ONLY_DEFINE, LOG_ONLY_ENV, parseDecisionLog } from '../../../bench/shadow/logContract.js';

const entry = (v: Decision['v'], why = 'G11'): Decision => ({ v, why, url: 'https://popunder.example/ad' });

describe('log-only contract (P2-61; the guard honours it in P2-57)', () => {
  test('names: env, build define and the decision-log attribute', () => {
    expect([LOG_ONLY_ENV, LOG_ONLY_DEFINE, LOG_ATTRIBUTE]).toEqual(['GLASSMERE_POPUP_LOG_ONLY', '__POPUP_GUARD_LOG_ONLY__', 'data-sp-log']);
  });

  test('a log is a JSON array of decisions; a missing attribute is an empty log', () => {
    expect(parseDecisionLog(JSON.stringify([entry('would-block'), entry('allow', 'G13')]))).toEqual({
      ok: true,
      entries: [entry('would-block'), entry('allow', 'G13')],
    });
    expect(parseDecisionLog(null)).toEqual({ ok: true, entries: [] });
  });

  test('anything else is refused with a reason, never counted', () => {
    for (const raw of ['not json', '{}', JSON.stringify([{ v: 'maybe', why: 'x' }]), JSON.stringify([{ v: 'block' }])]) {
      expect(parseDecisionLog(raw).ok).toBe(false);
    }
  });
});

describe('shadow aggregation: would-block events per 500 gestures (pop-up notes §14, target ≤ 1)', () => {
  test('per-site and total rates; blocks in log-only mode count as would-block', () => {
    const report = aggregate([
      { site: 'a', gestures: 250, entries: [entry('would-block'), entry('allow')] },
      { site: 'b', gestures: 250, entries: [entry('block')] },
    ]);
    expect(report.sites).toEqual([
      { site: 'a', gestures: 250, wouldBlock: 1, per500: 2 },
      { site: 'b', gestures: 250, wouldBlock: 1, per500: 2 },
    ]);
    expect(report.total).toEqual({ gestures: 500, wouldBlock: 2, per500: 2 });
    expect(report.target).toBe(WOULD_BLOCK_TARGET_PER_500);
    expect(report.withinTarget).toBe(false);
  });

  test('no would-block is within target; no gesture at all is not (a run that did nothing proves nothing)', () => {
    expect(aggregate([{ site: 'a', gestures: 500, entries: [entry('allow')] }]).withinTarget).toBe(true);
    expect(aggregate([{ site: 'a', gestures: 0, entries: [] }])).toMatchObject({ total: { gestures: 0, wouldBlock: 0, per500: 0 }, withinTarget: false });
  });

  test('Markdown: one row per site and a total line', () => {
    const md = toMarkdown(aggregate([{ site: 'popups/p1', gestures: 2, entries: [entry('would-block')] }]));
    expect(md).toContain('| popups/p1 | 2 | 1 | 250.00 |');
    expect(md).toContain('| **total** | 2 | 1 | 250.00 |');
    expect(md).toContain('target ≤ 1');
  });
});
