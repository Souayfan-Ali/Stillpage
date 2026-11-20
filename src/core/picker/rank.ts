/**
 * Checks and orders selector candidates (P2-17). The probe is the content script's
 * `document.querySelectorAll` in a `try/catch`: `null` when the document refuses the selector.
 * Only candidates that pass `core/sanitise` and match the picked element survive.
 */
import { sanitiseSelector } from '../sanitise/selector.js';
import type { Candidate, RankedCandidate } from './types.js';

/** Result of trying one selector in the page, or `null` when the page's parser refuses it. */
export type Probe = (selector: string) => { readonly count: number; readonly includesTarget: boolean } | null;

/** Best first: higher score, then narrower (fewer matches), then shorter. */
const byRank = (a: RankedCandidate, b: RankedCandidate): number =>
  b.score - a.score || a.count - b.count || a.selector.length - b.selector.length;

/** Valid, de-duplicated candidates that match the target, ranked best first. Builds new objects. */
export function rankCandidates(candidates: readonly Candidate[], probe: Probe): readonly RankedCandidate[] {
  const seen = new Set<string>();
  const out: RankedCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.selector) || sanitiseSelector(c.selector) !== c.selector) continue;
    seen.add(c.selector);
    const result = probe(c.selector);
    if (result === null || !result.includesTarget || result.count < 1) continue;
    out.push({ ...c, count: result.count });
  }
  return out.sort(byRank);
}

/** The slider's order (UI notes §5): narrow to wide by match count, best rank first within a count. */
export function bySpread(ranked: readonly RankedCandidate[]): readonly RankedCandidate[] {
  return [...ranked].sort((a, b) => a.count - b.count || byRank(a, b));
}
