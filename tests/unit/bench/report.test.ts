import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { BENCH_PAGES, pageUrl } from '../../../bench/run/pages.js';
import { FIXTURES_DIR } from '../../fixtures/manifest.js';
import { summarise } from '../../../bench/run/stats.js';
import { buildReport, budgetRows, toMarkdown, type Sample } from '../../../bench/run/report.js';

describe('summarise (performance notes §3: median and interquartile range, never a single run)', () => {
  test('odd and even counts, quartiles by linear interpolation', () => {
    expect(summarise([5, 1, 3])).toEqual({ n: 3, p25: 2, p50: 3, p75: 4, p95: 4.8 });
    expect(summarise([1, 2, 3, 4])).toEqual({ n: 4, p25: 1.75, p50: 2.5, p75: 3.25, p95: 3.85 });
  });

  test('null readings are dropped; nothing left is n = 0 with nulls', () => {
    expect(summarise([null, 7])).toMatchObject({ n: 1, p50: 7 });
    expect(summarise([null])).toEqual({ n: 0, p25: null, p50: null, p75: null, p95: null });
  });
});

const sample = (config: string, page: string, cpuMs: number, extra: Partial<Sample> = {}): Sample => ({
  config,
  page,
  run: 0,
  fcp: 10,
  lcp: 12,
  load: 20,
  cpuMs,
  tbt: 0,
  requests: 10,
  blocked: 0,
  kB: 100,
  ...extra,
});

const ENV = { commit: 'abc1234', node: 'v22', chromium: '158', os: 'linux', cpu: 'x', loadBefore: [1, 2, 3], loadAfter: [2, 2, 2], runs: 2, at: '2026-11-14T00:00:00Z' };

describe('report', () => {
  test('one cell per config and page with medians; the environment and load are recorded', () => {
    const report = buildReport([sample('none', 'blank', 10), sample('none', 'blank', 12), sample('ours', 'blank', 20), sample('ours', 'blank', 22)], [], ENV);
    expect(report.env.loadBefore).toEqual([1, 2, 3]);
    expect(report.cells.map((c) => [c.config, c.page, c.metrics.cpuMs.p50])).toEqual([
      ['none', 'blank', 11],
      ['ours', 'blank', 21],
    ]);
  });

  test('budget rows of performance notes §2.5 against "none" in the same run', () => {
    const samples = [
      sample('none', 'blank', 10, { fcp: 30 }),
      sample('ours', 'blank', 20, { fcp: 50 }),
      sample('ubol', 'blank', 50, { fcp: 60 }),
      sample('none', 'adheavy-1', 200, { kB: 400 }),
      sample('ours', 'adheavy-1', 60, { kB: 100 }),
    ];
    const rows = budgetRows(buildReport(samples, [], ENV));
    expect(rows).toEqual(
      expect.arrayContaining([
        { what: 'blank: CPU delta (ms)', value: 10, limit: '≤ 14', ok: true },
        { what: 'blank: FCP delta (ms)', value: 20, limit: '≤ 14', ok: false },
        { what: 'blank: CPU delta vs half of uBOL\'s (ms)', value: 10, limit: '≤ 20', ok: true },
        { what: 'adheavy-1: CPU reduction (%)', value: 70, limit: '≥ 50', ok: true },
        { what: 'adheavy-1: bytes reduction (%)', value: 75, limit: '≥ 50', ok: true },
      ]),
    );
  });

  test('ADR-017: the 10-cross-site-frame fixture (adheavy-3) is held to uBOL + 20 ms absolute, the others to + 5 %', () => {
    const rows = budgetRows(buildReport([
      sample('none', 'adheavy-3', 235), sample('ours', 'adheavy-3', 83), sample('ubol', 'adheavy-3', 66),
      sample('none', 'adheavy-1', 200), sample('ours', 'adheavy-1', 70), sample('ubol', 'adheavy-1', 66),
    ], [], ENV));
    expect(rows.find((r) => r.what === 'adheavy-3: CPU vs uBOL (ms, ADR-017)')).toEqual({ what: 'adheavy-3: CPU vs uBOL (ms, ADR-017)', value: 17, limit: '≤ +20', ok: true });
    expect(rows.find((r) => r.what === 'adheavy-1: CPU vs uBOL (%)')).toMatchObject({ value: 6.1, ok: false });
  });

  test('guard on (ours-guard): blank-page CPU and FCP each + ≤ 16 ms over none (performance notes §2.5, P2-47 follow-up)', () => {
    const rows = budgetRows(buildReport([
      sample('none', 'blank', 10, { fcp: 30 }), sample('ours', 'blank', 20, { fcp: 40 }), sample('ours-guard', 'blank', 27, { fcp: 47 }),
    ], [], ENV));
    expect(rows).toEqual(expect.arrayContaining([
      { what: 'blank, guard on: CPU delta (ms)', value: 17, limit: '≤ 16', ok: false },
      { what: 'blank, guard on: FCP delta (ms)', value: 17, limit: '≤ 16', ok: false },
    ]));
    expect(rows.filter((r) => r.what.startsWith('blank: '))).toHaveLength(2);
  });

  test('D-66 / ADR-019: article LCP in presented frames (≤ 1), not above uBOL, CPU within the blank-page bound', () => {
    const rows = budgetRows(buildReport([
      sample('none', 'article', 19, { lcp: 32 }), sample('ours', 'article', 33, { lcp: 52 }), sample('ubol', 'article', 60, { lcp: 52 }),
    ], [], ENV));
    expect(rows).toEqual(expect.arrayContaining([
      { what: 'article: LCP delta (frames at 60 Hz)', value: 1, limit: '≤ 1', ok: true },
      { what: 'article: LCP vs uBOL (ms)', value: 0, limit: '≤ 0', ok: true },
      { what: 'article: CPU delta (ms)', value: 14, limit: '≤ 14', ok: true },
    ]));
    expect(rows.some((r) => r.what === 'article: LCP delta (ms)')).toBe(false);
    const late = budgetRows(buildReport([sample('none', 'article', 19, { lcp: 32 }), sample('ours', 'article', 20, { lcp: 66 })], [], ENV));
    expect(late.find((r) => r.what.startsWith('article: LCP delta'))).toMatchObject({ value: 2, ok: false });
  });

  test('a missing cell gives no budget row rather than a fake pass', () => {
    expect(budgetRows(buildReport([sample('ours', 'blank', 20)], [], ENV))).toEqual([]);
  });

  test('Markdown: environment line, one table row per cell, budget table, skipped configs', () => {
    const report = buildReport([sample('none', 'blank', 10), sample('ours', 'blank', 20)], [{ config: 'ubol', reason: 'not found' }], ENV);
    const md = toMarkdown(report);
    expect(md).toContain('abc1234');
    expect(md).toContain('load 1 / 2 / 3 → 2 / 2 / 2');
    expect(md).toMatch(/\| ours \| blank \| 10 \| 12 \| 20 \| 20 \(20–20\) \| 0 \| 10 \| 0 \| 100 \|/);
    expect(md).toContain('| blank: CPU delta (ms) | 10 | ≤ 14 | ok |');
    expect(md).toContain('ubol: not found');
  });
});

describe('per-configuration figures', () => {
  test('package size, browser PSS, worker heap and wake-ups get their own table; absent readings show a dash', () => {
    const n = { n: 0, p25: null, p50: null, p75: null, p95: null };
    const one = (x: number) => ({ n: 1, p25: x, p50: x, p75: x, p95: x });
    const report = buildReport([sample('ours', 'blank', 20)], [], ENV, { ours: { packageKiB: 16616, browserPssKiB: one(211021), workerHeapKiB: n, wakeUps: one(0) } });
    expect(toMarkdown(report)).toContain('| ours | 16616 | 211021 | – | 0 | – |');
  });

  test('script bytes named by the registrations, summed over registrations and unique (P2-47, non-gating)', () => {
    const report = buildReport([sample('ours', 'blank', 20)], [], ENV, { ours: { packageKiB: 1, scriptSummedKiB: 61035, scriptUniqueKiB: 3305 } });
    expect(toMarkdown(report)).toContain('| ours | 1 | – | – | – | 61035 / 3305 |');
  });
});

describe('benchmark pages', () => {
  test('every page of the harness is a perf/ fixture with its comment, and the ad frame exists', () => {
    for (const page of [...BENCH_PAGES, 'frame']) {
      const file = path.join(FIXTURES_DIR, 'perf', `${page}.html`);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain(`<!-- fixture: perf/${page} · `);
    }
    expect(pageUrl('blank')).toBe('https://news.bench.example/perf/blank.html');
  });
});
