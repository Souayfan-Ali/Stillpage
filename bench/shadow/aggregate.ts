/**
 * Shadow-run aggregation (P2-61, testing notes §8, pop-up notes §14): would-block events per 500 scripted
 * gestures, per site and in total, against the ≤ 1 target. In log-only mode every `block` the guard
 * records is a would-block. A run with no gesture is never "within target".
 */
import type { Decision } from './logContract.js';

export const WOULD_BLOCK_TARGET_PER_500 = 1;
const PER = 500;

export interface SiteSample {
  readonly site: string;
  readonly gestures: number;
  readonly entries: readonly Decision[];
}

interface Rate {
  readonly gestures: number;
  readonly wouldBlock: number;
  readonly per500: number;
}

export interface ShadowReport {
  readonly sites: readonly (Rate & { readonly site: string })[];
  readonly total: Rate;
  readonly target: number;
  readonly withinTarget: boolean;
}

const rate = (gestures: number, wouldBlock: number): Rate => ({ gestures, wouldBlock, per500: gestures === 0 ? 0 : (wouldBlock / gestures) * PER });

export function aggregate(samples: readonly SiteSample[]): ShadowReport {
  const sites = samples.map((s) => ({ site: s.site, ...rate(s.gestures, s.entries.filter((e) => e.v !== 'allow').length) }));
  const total = rate(
    sites.reduce((n, s) => n + s.gestures, 0),
    sites.reduce((n, s) => n + s.wouldBlock, 0),
  );
  return { sites, total, target: WOULD_BLOCK_TARGET_PER_500, withinTarget: total.gestures > 0 && total.per500 <= WOULD_BLOCK_TARGET_PER_500 };
}

const row = (name: string, r: Rate): string => `| ${name} | ${String(r.gestures)} | ${String(r.wouldBlock)} | ${r.per500.toFixed(2)} |`;

export function toMarkdown(report: ShadowReport): string {
  return [
    `Would-block events per 500 gestures: ${report.total.per500.toFixed(2)} (target ≤ ${String(report.target)}, ${report.withinTarget ? 'within' : 'NOT within'} target)`,
    '',
    '| Site | Gestures | Would block | Per 500 |',
    '|---|---|---|---|',
    ...report.sites.map((s) => row(s.site, s)),
    row('**total**', report.total),
    '',
  ].join('\n');
}
