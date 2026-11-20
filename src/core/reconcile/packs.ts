/**
 * Pack selection under Chrome's limits (P1-06, P2-26). Enabled packs are taken default packs first,
 * then in catalog order; a pack that would cross a limit is skipped whole and reported with what it
 * needed and what was left, so the UI can say so (filter-pipeline notes §8) instead of Chrome silently refusing a
 * ruleset — or, for the static rule pool, refusing the whole `updateEnabledRulesets` call.
 */
import type { Catalog, CatalogPack } from '../catalog/types.js';
import type { Hostname, PackId, RulesetId } from '../ids.js';
import { own } from '../record.js';
import type { Settings } from '../state/types.js';
import { isPackEnabled } from './packChoice.js';
import { toRegistration, type Scope } from './registrations.js';
import type { RuleCapacity, ScriptRegistration, SkippedPack, SkipReason } from './types.js';

/** Limits a desired state must respect. */
export interface DesiredLimits {
  readonly enabledRulesets: number;
  readonly staticRegex: number;
  readonly registrations: number;
  readonly patterns: number;
}

/** Everything the level and grant inputs decide for packs. */
export interface PackContext {
  readonly catalog: Catalog;
  readonly allSites: boolean;
  readonly scope: Scope;
  readonly lowered: readonly Hostname[];
  readonly limits: DesiredLimits;
  /** `null` when the pool could not be read: no rule check, Chrome's own error surfaces. */
  readonly capacity: RuleCapacity | null;
}

interface Selection {
  readonly rulesets: readonly RulesetId[];
  readonly regex: number;
  readonly registrations: readonly ScriptRegistration[];
  readonly patterns: number;
  /** Rule ceilings of rulesets this selection newly enables (not enabled in Chrome now). */
  readonly newRules: number;
  readonly skipped: readonly SkippedPack[];
}

const EMPTY: Selection = { rulesets: [], regex: 0, registrations: [], patterns: 0, newRules: 0, skipped: [] };


interface Measure {
  readonly reason: SkipReason;
  readonly used: (s: Selection) => number;
  readonly limit: number;
}

function measures(ctx: PackContext): readonly Measure[] {
  const { limits, capacity } = ctx;
  return [
    { reason: 'ruleset-slots', used: (s) => s.rulesets.length, limit: limits.enabledRulesets },
    { reason: 'regex-pool', used: (s) => s.regex, limit: limits.staticRegex },
    ...(capacity === null ? [] : [{ reason: 'rule-pool' as const, used: (s: Selection) => s.newRules, limit: capacity.available }]),
    { reason: 'registrations', used: (s) => s.registrations.length, limit: limits.registrations },
    { reason: 'patterns', used: (s) => s.patterns, limit: limits.patterns },
  ];
}

function overLimit(acc: Selection, next: Selection, pack: PackId, ctx: PackContext): SkippedPack | null {
  const crossed = measures(ctx).find((m) => m.used(next) > m.limit);
  if (crossed === undefined) return null;
  const needed = crossed.used(next) - crossed.used(acc);
  return { pack, reason: crossed.reason, needed, available: Math.max(0, crossed.limit - crossed.used(acc)) };
}

const ceiling = (ctx: PackContext, ids: readonly RulesetId[], field: 'maxRules' | 'maxRegex'): number =>
  ids.reduce((sum, r) => sum + (own(ctx.catalog.rulesets, r)?.[field] ?? 0), 0);

function addPack(acc: Selection, id: PackId, pack: CatalogPack, ctx: PackContext): Selection {
  const rulesets = pack.rulesets.filter((r) => ctx.allSites || own(ctx.catalog.rulesets, r)?.needsHostAccess === false);
  const fresh = rulesets.filter((r) => !(ctx.capacity?.enabled.includes(r) ?? false));
  const registrations = pack.registrations
    .map((template) => toRegistration(template, ctx.scope, ctx.lowered))
    .filter((r): r is ScriptRegistration => r !== null);
  const next: Selection = {
    rulesets: [...acc.rulesets, ...rulesets],
    regex: acc.regex + ceiling(ctx, rulesets, 'maxRegex'),
    registrations: [...acc.registrations, ...registrations],
    patterns: acc.patterns + registrations.reduce((sum, r) => sum + r.matches.length, 0),
    newRules: acc.newRules + ceiling(ctx, fresh, 'maxRules'),
    skipped: acc.skipped,
  };
  const skip = overLimit(acc, next, id, ctx);
  return skip === null ? next : { ...acc, skipped: [...acc.skipped, skip] };
}

/** Rulesets, registrations and skipped packs for the user's pack choices. */
export function selectPacks(settings: Settings, ctx: PackContext): Selection {
  const packs = Object.entries(ctx.catalog.packs) as [PackId, CatalogPack][];
  const ordered = [...packs.filter(([, p]) => p.default), ...packs.filter(([, p]) => !p.default)];
  return ordered.reduce(
    (acc, [id, pack]) => (isPackEnabled(settings, id, pack.default) ? addPack(acc, id, pack, ctx) : acc),
    EMPTY,
  );
}
