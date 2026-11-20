/**
 * The build report (`dist/compiler/report.json`, P1-32): counts and head-room per slot, the default
 * totals, bucket overhead, pop-up accounting, regex figures, rejections by reason and the share of
 * extra rejections (reasons uBOL can express, filter-pipeline notes §4 gate ≤ 1 %). Deterministic: no timings.
 */
import { DEFAULT_PATTERN_BUDGET, DEFAULT_REGEX_BUDGET, DEFAULT_RULE_BUDGET, REGISTERED_SCRIPT_BYTES_BUDGET } from '../../src/core/limits.js';
import { registeredFileBytes } from '../verify/content.js';
import { scriptBytes } from '../verify/patterns.js';
import { REASONS } from '../normalise/reasons.js';
import type { PopupBuild } from '../popups/emit.js';
import type { LiftSummary } from '../popups/lift.js';
import type { Slot, SlotCount } from '../postpass/budgets.js';
import type { Ledger } from '../postpass/ledger.js';
import type { ContentBuild } from '../content/build.js';
import type { NetworkRuleset } from './network.js';

/** Extra rejections above this share of the network filters fail the filter-pipeline notes §4 gate (S-02a). */
const MAX_EXTRA_REJECTION_SHARE = 0.01;

export interface ReportInput {
  readonly slots: readonly Slot[];
  readonly counts: ReadonlyMap<string, SlotCount>;
  readonly network: readonly NetworkRuleset[];
  readonly popups: PopupBuild;
  readonly lift: LiftSummary;
  readonly overhead: number;
  readonly ledgers: ReadonlyMap<string, Ledger>;
  readonly regexAsked: number;
  readonly regexTotal: number;
  readonly content?: ContentBuild | undefined;
  readonly defaultPacks: ReadonlySet<string>;
}

export type BuildReport = ReturnType<typeof buildReport>;

const histogram = (keys: readonly string[]): Record<string, number> =>
  Object.fromEntries([...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => (a < b ? -1 : 1)));

function slotRows(slots: readonly Slot[], counts: ReadonlyMap<string, SlotCount>) {
  return Object.fromEntries(slots.map((s) => {
    const c = counts.get(s.id) ?? { rules: 0, regex: 0, bytes: 0 };
    return [s.id, { ...c, maxRules: s.budget.rules, maxRegex: s.budget.regex, default: s.isDefault }];
  }));
}

/** Match patterns and registrations per pack and for the default packs (ADR-010 budgets). */
function contentRows(content: ContentBuild | undefined, defaults: ReadonlySet<string>) {
  if (content === undefined) return { patterns: { default: 0, all: 0, max: DEFAULT_PATTERN_BUDGET }, registrations: { default: 0, all: 0 } };
  const sum = (r: Readonly<Record<string, number>>, pick: (p: string) => boolean): number => Object.entries(r).filter(([p]) => pick(p)).reduce((n, [, v]) => n + v, 0);
  const s = content.stats;
  return {
    patterns: { default: sum(s.patterns, (p) => defaults.has(p)), all: sum(s.patterns, () => true), max: DEFAULT_PATTERN_BUDGET, byPack: s.patterns },
    registrations: { default: sum(s.registrations, (p) => defaults.has(p)), all: sum(s.registrations, () => true), byPack: s.registrations },
    worstShardBytes: s.worstShardBytes, failOpenExceptions: s.failOpenExceptions, removedByExceptions: s.removedByExceptions,
    unresolvedExceptions: s.unresolvedExceptions, lostEntities: s.lostEntities, facts: s.facts,
    /** Generic cosmetic data per pack (P2-23): selectors, tokens, always, unhide, exception hosts, unsupported, bytes. */
    generic: s.generic,
    /** Script bytes the default registrations name: summed (as Chrome stores them) and unique (D-41). */
    scriptBytes: { ...scriptBytes([...content.registrations].filter(([p]) => defaults.has(p)).flatMap(([, r]) => r), registeredFileBytes(content.files)), max: REGISTERED_SCRIPT_BYTES_BUDGET },
  };
}

function totals(slots: readonly Slot[], counts: ReadonlyMap<string, SlotCount>) {
  const of = (pick: (s: Slot) => boolean, key: 'rules' | 'regex'): number =>
    slots.filter(pick).reduce((n, s) => n + (counts.get(s.id)?.[key] ?? 0), 0);
  return {
    default: { rules: of((s) => s.isDefault, 'rules'), regex: of((s) => s.isDefault, 'regex'), maxRules: DEFAULT_RULE_BUDGET, maxRegex: DEFAULT_REGEX_BUDGET },
    all: { rules: of(() => true, 'rules'), regex: of(() => true, 'regex') },
  };
}

/** P1-30: `redirect=none` blocks, and redirects dropped for an unknown name, an external URL or an HTML type. */
function redirectRows(log: ReportInput['network'][number]['log'], network: ReportInput['network']) {
  const of = (reason: string) => log.filter((l) => l.reason === reason);
  return { noneAsBlock: network.reduce((n, r) => n + r.redirectNone, 0), unknown: of('redirect-unknown'), external: of('redirect-external').length, htmlType: of('redirect-html-type').length };
}

/** Builds the report value. */
export function buildReport(i: ReportInput) {
  const networkLog = i.network.flatMap((r) => r.log);
  const filters = i.network.reduce((n, r) => n + r.networkFilters, 0);
  const extra = networkLog.filter((l) => !REASONS[l.reason].ubolAlso).length;
  return {
    schema: 1,
    slots: slotRows(i.slots, i.counts),
    totals: totals(i.slots, i.counts),
    content: contentRows(i.content, i.defaultPacks),
    bucketOverhead: i.overhead,
    popups: { ...i.popups.accounting, bySource: Object.fromEntries(i.network.filter((r) => r.popupEntries.length > 0).map((r) => [r.config.id, r.popupEntries.length])),
      rules: i.popups.rules.length, byShape: i.popups.byShape, destinations: i.popups.destinations.length,
      strictSites: i.popups.strictSites.length, lostEntities: i.popups.lostEntities,
      lift: { candidates: i.lift.candidates, lifted: i.lift.lifted, byRuleset: i.lift.byRuleset,
        excluded: { malware: i.lift.excluded.malware.length, allow: i.lift.excluded.allow.length } } },
    regex: { distinct: i.regexTotal, askedChromium: i.regexAsked },
    redirects: redirectRows(networkLog, i.network),
    rejections: histogram([...networkLog, ...i.popups.log, ...(i.content?.log ?? [])].map((l) => l.reason)),
    extraRejections: { networkFilters: filters, extra, share: filters === 0 ? 0 : extra / filters, max: MAX_EXTRA_REJECTION_SHARE },
    ledgerFallbackKeys: [...i.ledgers.values()].reduce((n, l) => n + Object.keys(l.entries).filter((k) => k.startsWith('c:')).length, 0),
  };
}
