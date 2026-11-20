/**
 * Benchmark report (P2-46, performance notes §4, §7): samples → one cell per configuration and page with the
 * spread of every metric → JSON, a Markdown summary, and the page-load rows of performance notes §2.5 computed
 * against "none" (and uBOL where it ran) in the same run. Local runs are informational: timing gates
 * belong to the nightly job with a tolerance (performance notes §3), so nothing here exits non-zero on a budget.
 */
import { summarise, type Summary } from './stats.js';

const METRICS = ['fcp', 'lcp', 'load', 'cpuMs', 'tbt', 'requests', 'blocked', 'kB'] as const;
type Metric = (typeof METRICS)[number];

export type Sample = Readonly<{ config: string; page: string; run: number } & Record<Metric, number | null>>;

export interface Env {
  readonly commit: string;
  readonly node: string;
  readonly chromium: string;
  readonly os: string;
  readonly cpu: string;
  /** `os.loadavg()` before and after the run (performance notes §3: results are load-sensitive). */
  readonly loadBefore: readonly number[];
  readonly loadAfter: readonly number[];
  readonly runs: number;
  readonly at: string;
  /** Extension builds under test, e.g. `ours 0.0.1, ubol 2026.1110.1816`. */
  readonly builds?: string;
}

interface Cell {
  readonly config: string;
  readonly page: string;
  readonly metrics: Readonly<Record<Metric, Summary>>;
}

export interface Report {
  readonly schema: 1;
  readonly env: Env;
  readonly cells: readonly Cell[];
  readonly skipped: readonly { readonly config: string; readonly reason: string }[];
  /** Per configuration, not per page: package size, worker heap, wake-ups, browser PSS. */
  readonly extras?: Readonly<Record<string, Readonly<Record<string, Summary | number>>>>;
}

export function buildReport(samples: readonly Sample[], skipped: Report['skipped'], env: Env, extras?: Report['extras']): Report {
  const keys = [...new Set(samples.map((s) => `${s.config}\u0000${s.page}`))];
  const cells = keys.map((key) => {
    const [config = '', page = ''] = key.split('\u0000');
    const of = samples.filter((s) => s.config === config && s.page === page);
    const metrics = Object.fromEntries(METRICS.map((m) => [m, summarise(of.map((s) => s[m]))])) as Record<Metric, Summary>;
    return { config, page, metrics };
  });
  return { schema: 1, env, cells, skipped, ...(extras && { extras }) };
}

export interface BudgetRow {
  readonly what: string;
  readonly value: number;
  readonly limit: string;
  readonly ok: boolean;
}

const BLANK_DELTA_MS = 14;
/** Blank page with the pop-up guard on (`ours-guard`): FCP and CPU each + ≤ 16 ms. */
const BLANK_GUARD_DELTA_MS = 16;
/** ADR-019 (D-66): LCP moves in presented frames; the article may add at most one (60 Hz bench display). */
const FRAME_MS = 1000 / 60;
const ARTICLE_LCP_FRAMES = 1;
const AD_REDUCTION_PCT = 50;
const UBOL_TOLERANCE_PCT = 5;
/** ADR-017: on the fixture with ten cross-site frames, CPU ≤ uBOL + 20 ms (D-18's per-document pattern cost). */
const FRAME_HEAVY_PAGE = 'adheavy-3';
const FRAME_HEAVY_UBOL_MS = 20;

const median = (r: Report, config: string, page: string, m: Metric): number | null =>
  r.cells.find((c) => c.config === config && c.page === page)?.metrics[m].p50 ?? null;
const round1 = (x: number): number => Math.round(x * 10) / 10;

function delta(r: Report, page: string, m: Metric, label: string, limit: number, config = 'ours', name = page): BudgetRow[] {
  const ours = median(r, config, page, m);
  const none = median(r, 'none', page, m);
  if (ours === null || none === null) return [];
  const value = round1(ours - none);
  return [{ what: `${name}: ${label} delta (ms)`, value, limit: `≤ ${String(limit)}`, ok: value <= limit }];
}

/** ADR-019: the article's LCP delta in frames, not above uBOL's LCP, and its CPU within the blank-page bound. */
function article(r: Report): BudgetRow[] {
  const [ours, none, ubol] = (['ours', 'none', 'ubol'] as const).map((c) => median(r, c, 'article', 'lcp'));
  const frames = ours == null || none == null ? [] : [Math.round((ours - none) / FRAME_MS)].map((value) => ({ what: 'article: LCP delta (frames at 60 Hz)', value, limit: `≤ ${String(ARTICLE_LCP_FRAMES)}`, ok: value <= ARTICLE_LCP_FRAMES }));
  const vsUbol = ours == null || ubol == null ? [] : [round1(ours - ubol)].map((value) => ({ what: 'article: LCP vs uBOL (ms)', value, limit: '≤ 0', ok: value <= 0 }));
  return [...frames, ...vsUbol, ...delta(r, 'article', 'cpuMs', 'CPU', BLANK_DELTA_MS)];
}

function halfOfUbol(r: Report): BudgetRow[] {
  const [ours, none, ubol] = (['ours', 'none', 'ubol'] as const).map((c) => median(r, c, 'blank', 'cpuMs'));
  if (ours == null || none == null || ubol == null) return [];
  const value = round1(ours - none);
  const limit = round1((ubol - none) / 2);
  return [{ what: 'blank: CPU delta vs half of uBOL\'s (ms)', value, limit: `≤ ${String(limit)}`, ok: value <= limit }];
}

function versusUbol(page: string, ours: number, ubol: number): BudgetRow {
  if (page === FRAME_HEAVY_PAGE) {
    const value = round1(ours - ubol);
    return { what: `${page}: CPU vs uBOL (ms, ADR-017)`, value, limit: `≤ +${String(FRAME_HEAVY_UBOL_MS)}`, ok: value <= FRAME_HEAVY_UBOL_MS };
  }
  const value = round1((ours / ubol - 1) * 100);
  return { what: `${page}: CPU vs uBOL (%)`, value, limit: `≤ +${String(UBOL_TOLERANCE_PCT)}`, ok: value <= UBOL_TOLERANCE_PCT };
}

function adHeavy(r: Report, page: string): BudgetRow[] {
  const rows: BudgetRow[] = [];
  for (const [m, label] of [['cpuMs', 'CPU'], ['kB', 'bytes']] as const) {
    const ours = median(r, 'ours', page, m);
    const none = median(r, 'none', page, m);
    if (ours !== null && none !== null && none > 0) {
      const value = round1((1 - ours / none) * 100);
      rows.push({ what: `${page}: ${label} reduction (%)`, value, limit: `≥ ${String(AD_REDUCTION_PCT)}`, ok: value >= AD_REDUCTION_PCT });
    }
  }
  const ours = median(r, 'ours', page, 'cpuMs');
  const ubol = median(r, 'ubol', page, 'cpuMs');
  if (ours !== null && ubol !== null && ubol > 0) rows.push(versusUbol(page, ours, ubol));
  return rows;
}

/** The page-load rows of performance notes §2.5 that this run can compute. */
export function budgetRows(r: Report): readonly BudgetRow[] {
  const pages = [...new Set(r.cells.map((c) => c.page))];
  return [
    ...delta(r, 'blank', 'cpuMs', 'CPU', BLANK_DELTA_MS),
    ...delta(r, 'blank', 'fcp', 'FCP', BLANK_DELTA_MS),
    ...halfOfUbol(r),
    ...delta(r, 'blank', 'cpuMs', 'CPU', BLANK_GUARD_DELTA_MS, 'ours-guard', 'blank, guard on'),
    ...delta(r, 'blank', 'fcp', 'FCP', BLANK_GUARD_DELTA_MS, 'ours-guard', 'blank, guard on'),
    ...article(r),
    ...delta(r, 'article', 'tbt', 'TBT', 0),
    ...pages.filter((p) => p.startsWith('adheavy')).flatMap((p) => adHeavy(r, p)),
  ];
}

const fmt = (x: number | null): string => (x === null ? '–' : String(Math.round(x * 10) / 10));
const spread = (s: Summary): string => `${fmt(s.p50)} (${fmt(s.p25)}–${fmt(s.p75)})`;

function cellRow(c: Cell): string {
  const m = c.metrics;
  return `| ${c.config} | ${c.page} | ${fmt(m.fcp.p50)} | ${fmt(m.lcp.p50)} | ${fmt(m.load.p50)} | ${spread(m.cpuMs)} | ${fmt(m.tbt.p50)} | ${fmt(m.requests.p50)} | ${fmt(m.blocked.p50)} | ${fmt(m.kB.p50)} |`;
}

const figure = (x: Summary | number | undefined): string => (x === undefined ? '–' : typeof x === 'number' ? fmt(x) : fmt(x.p50));

/** Chrome holds each registration's script text apart (P2-47), so the summed figure is what memory pays. */
const scriptKiB = (x: Readonly<Record<string, Summary | number>>): string =>
  x['scriptSummedKiB'] === undefined ? '–' : `${figure(x['scriptSummedKiB'])} / ${figure(x['scriptUniqueKiB'])}`;

function extrasTable(r: Report): string[] {
  if (r.extras === undefined) return [];
  return [
    '| Config | Package (KiB) | Browser PSS (KiB) | Worker heap after settle (KiB) | Wake-ups during the pages | Registered script KiB, summed / unique |',
    '|---|---|---|---|---|---|',
    ...Object.entries(r.extras).map(([c, x]) => `| ${c} | ${figure(x['packageKiB'])} | ${figure(x['browserPssKiB'])} | ${figure(x['workerHeapKiB'])} | ${figure(x['wakeUps'])} | ${scriptKiB(x)} |`),
    '',
  ];
}

export function toMarkdown(r: Report): string {
  const e = r.env;
  return [
    `Benchmark ${e.at} · commit ${e.commit} · ${String(e.runs)} runs per cell · Chromium ${e.chromium} · Node ${e.node} · ${e.os} · ${e.cpu}`,
    ...(e.builds === undefined ? [] : [`Builds: ${e.builds}.`]),
    `Machine load ${e.loadBefore.join(' / ')} → ${e.loadAfter.join(' / ')} (1 / 5 / 15 min); timings are load-sensitive.`,
    '',
    'Medians (ms, kB); CPU as median (p25–p75).',
    '',
    '| Config | Page | FCP | LCP | Load | CPU | TBT | Requests | Blocked | kB |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...r.cells.map(cellRow),
    '',
    ...extrasTable(r),
    '| Budget (performance notes §2.5) | Value | Limit | |',
    '|---|---|---|---|',
    ...budgetRows(r).map((b) => `| ${b.what} | ${String(b.value)} | ${b.limit} | ${b.ok ? 'ok' : 'OVER'} |`),
    '',
    ...r.skipped.map((s) => `Skipped ${s.config}: ${s.reason}`),
    '',
  ].join('\n');
}
