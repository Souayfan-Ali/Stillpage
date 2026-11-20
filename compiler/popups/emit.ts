/**
 * The `popups` ruleset and its two packaged host lists (filter-pipeline notes §7a, P1-49). Rules stay in the pop-up
 * band (`block` 1, `allow` 3; never shifted, ADR-011) and go through dedupe and bucketed coalescing
 * like every other ruleset; the ledger, validation and budgets follow in the shared post-pass.
 */
import type { NetworkRule } from '@adguard/agtree';
import type { ConvertedRule } from '../convert/convert.js';
import type { LogEntry } from '../normalise/normalise.js';
import type { Entry } from '../parse/parse-list.js';
import { bucketRuleset } from '../postpass/buckets.js';
import { pruneHosts, type BucketedRule } from '../postpass/coalesce.js';
import { dedupe } from '../postpass/dedupe.js';
import { popupOutcome, type PopupShape } from './shapes.js';

/** Bucket category for pop-up destinations outside the entity map (`other:popup`). */
const CATEGORY = 'popup';

export interface PopupBuild {
  readonly rules: readonly BucketedRule[];
  /** Pruned, sorted hosts of the plain `||host^$popup` blocks (`popup-destinations.json`). */
  readonly destinations: readonly string[];
  /** Sorted strict sites (`popup-strict-sites.json`). */
  readonly strictSites: readonly string[];
  readonly log: readonly LogEntry[];
  /** Filters per outcome; `rule + strict + log = filters`. */
  readonly accounting: Readonly<Record<'filters' | 'rule' | 'strict' | 'log', number>>;
  readonly byShape: Readonly<Partial<Record<PopupShape, number>>>;
  /** Entity site names no filter of the build names (reported, D-20). */
  readonly lostEntities: readonly string[];
  /** Rules with a single bucket, for the overhead figure. */
  readonly maximal: number;
}

const asNode = (e: Entry): NetworkRule | undefined =>
  e.node?.category === 'Network' && e.node.type === 'NetworkRule' ? e.node : undefined;

interface Acc {
  readonly converted: ConvertedRule[];
  readonly destinations: Set<string>;
  readonly strict: Set<string>;
  readonly lost: Set<string>;
  readonly log: LogEntry[];
  readonly byShape: Partial<Record<PopupShape, number>>;
  readonly count: Record<'rule' | 'strict' | 'log', number>;
}

function add(acc: Acc, e: Entry, stems: ReadonlyMap<string, readonly string[]>): void {
  const node = asNode(e);
  const o = node === undefined ? { kind: 'log' as const, reason: 'popup-unsupported' as const, detail: 'not a network filter' } : popupOutcome(node, stems);
  acc.count[o.kind] += 1;
  if (o.kind === 'log') {
    acc.log.push({ source: e.source, reason: o.reason, ...(o.detail !== undefined && { detail: o.detail }) });
  } else if (o.kind === 'strict') {
    for (const s of o.sites) acc.strict.add(s);
    for (const l of o.lost) acc.lost.add(l);
  } else {
    acc.byShape[o.shape] = (acc.byShape[o.shape] ?? 0) + 1;
    if (o.destination !== undefined) acc.destinations.add(o.destination);
    acc.converted.push({ rule: o.rule, sources: [{ text: e.source.text, source: e.source, fixes: [] }] });
  }
}

/** Builds the pop-up artefacts from the pop-up entries of the source rulesets (in config order). */
export function buildPopups(entries: readonly Entry[], stems: ReadonlyMap<string, readonly string[]>,
  entityOf: (host: string) => string | undefined): PopupBuild {
  const acc: Acc = { converted: [], destinations: new Set(), strict: new Set(), lost: new Set(), log: [], byShape: {}, count: { rule: 0, strict: 0, log: 0 } };
  for (const e of entries) add(acc, e, stems);
  const bucketed = bucketRuleset(dedupe(acc.converted).rules, entityOf, CATEGORY);
  return {
    rules: bucketed.rules,
    destinations: pruneHosts([...acc.destinations]),
    strictSites: [...acc.strict].sort(),
    log: acc.log,
    accounting: { filters: entries.length, ...acc.count },
    byShape: acc.byShape,
    lostEntities: [...acc.lost].sort(),
    maximal: bucketed.maximal,
  };
}

/** `h` or one of its parents is in `hosts`. */
function under(h: string, hosts: ReadonlySet<string>): boolean {
  for (let rest = h; ; rest = rest.slice(rest.indexOf('.') + 1)) {
    if (hosts.has(rest)) return true;
    if (!rest.includes('.')) return false;
  }
}

/** Destinations that no `block` rule of `rules` covers (must be empty: `popup-destinations.json` ⊆ `popups`). */
export function uncoveredDestinations(destinations: readonly string[], rules: readonly BucketedRule[]): readonly string[] {
  const hosts = new Set(rules.filter((r) => r.rule.action.type === 'block' && r.rule.condition.initiatorDomains === undefined
    && r.rule.condition.excludedInitiatorDomains === undefined && r.rule.condition.domainType === undefined)
    .flatMap((r) => r.rule.condition.requestDomains ?? (/^\|\|([a-z0-9.-]+)\^$/.exec(r.rule.condition.urlFilter ?? '')?.slice(1) ?? [])));
  return destinations.filter((d) => !under(d, hosts));
}
