/** Spread of a timing cell (performance notes §3: median and interquartile range, never a single run). */
export interface Summary {
  readonly n: number;
  readonly p25: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p95: number | null;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

/** Quantile `q` of sorted values, linear interpolation between closest ranks. */
function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)] ?? a;
  return round(a + (b - a) * (pos - lo));
}

/** Null readings (a metric the page did not produce) are dropped before summarising. */
export function summarise(values: readonly (number | null)[]): Summary {
  const sorted = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, p25: null, p50: null, p75: null, p95: null };
  return { n: sorted.length, p25: quantile(sorted, 0.25), p50: quantile(sorted, 0.5), p75: quantile(sorted, 0.75), p95: quantile(sorted, 0.95) };
}
