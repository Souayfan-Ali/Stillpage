/** Text derived from a `q/matchedRules` answer for the toolbar panel (P2-12). Pure. */
import type { MatchedRules } from '../../../core/messaging/matched.js';
import type { Category } from '../../../core/buckets/buckets.js';
import { formatNumber } from '../../../ui/i18n.js';
import { CATEGORY_LABELS, CATEGORY_NOUNS, OTHER_LABELS, PRIVACY_STRINGS } from './strings.js';

type Counts = Extract<MatchedRules, { kind: 'counts' }>;

/** Distinct named companies in the answer. */
function companyCount(counts: Counts): number {
  return new Set(counts.groups.flatMap((g) => g.buckets.filter((b) => b.name !== null).map((b) => b.id))).size;
}

/** One stat tile of the card (P3-18): the named companies, then one per category, in their words. */
export interface DetailPart {
  readonly kind: 'companies' | Category;
  readonly text: string;
}

export function detailParts(counts: Counts): readonly DetailPart[] {
  const companies = companyCount(counts);
  return [
    ...(companies > 0 ? [{ kind: 'companies' as const, text: PRIVACY_STRINGS.companies(companies) }] : []),
    ...counts.groups.map((g) => ({ kind: g.category, text: CATEGORY_NOUNS[g.category](g.count) })),
  ];
}

/** The card's second line: "9 companies · 14 ads · 13 trackers" (empty when nothing was blocked). */
export function detailLine(counts: Counts): string {
  return detailParts(counts)
    .map((part) => part.text)
    .join(' · ');
}

/**
 * The headline split around its figure ("27", " blocked on this page"), so the figure can be drawn large;
 * `null` when the words do not hold the figure (the headline is then drawn whole).
 */
export function splitCount(headline: string, n: number): readonly [string, string, string] | null {
  const figure = formatNumber(n);
  const at = headline.indexOf(figure);
  return n === 0 || at < 0 ? null : [headline.slice(0, at), figure, headline.slice(at + figure.length)];
}

/** A row's label: the company name, or "Other <category>". */
export const rowLabel = (category: Counts['groups'][number]['category'], name: string | null): string => name ?? OTHER_LABELS[category];

/** Distinct rules that matched (listed + the rest). */
export const ruleCount = (counts: Counts): number => counts.rules.length + counts.moreRules;

/** "Copy summary": plain text, the host name and counts only, never a request address. */
export function summaryText(host: string | null, counts: Counts): string {
  const lines = counts.groups.flatMap((g) => [
    `${CATEGORY_LABELS[g.category]}: ${String(g.count)}`,
    ...g.buckets.map((b) => `  ${rowLabel(g.category, b.name)}: ${String(b.count)}`),
  ]);
  return [
    host === null ? PRIVACY_STRINGS.titleNoHost : PRIVACY_STRINGS.title(host),
    ...(lines.length === 0 ? [PRIVACY_STRINGS.empty] : lines),
    PRIVACY_STRINGS.precise(counts.total, ruleCount(counts)),
    PRIVACY_STRINGS.scope,
  ].join('\n');
}
