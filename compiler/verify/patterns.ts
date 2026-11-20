/**
 * Structured match-pattern budgets (P2-32, design review 2026-11-14; `src/core/limits.ts`): the default set, the
 * optional non-regional packs together, each regional pack, and default + every non-regional + the
 * largest regional (what a user can enable together inside the runtime cap).
 */
import type { CatalogRegistration } from '../../src/core/catalog/registrations.js';
import {
  DEFAULT_PATTERN_BUDGET, ENABLED_PATTERN_BUDGET, GENERIC_PACK_MAX_BYTES, OPTIONAL_NON_REGIONAL_PATTERN_BUDGET, REGIONAL_PACK_PATTERN_BUDGET,
} from '../../src/core/limits.js';

export interface PackKinds {
  readonly defaults: ReadonlySet<string>;
  readonly regional: ReadonlySet<string>;
}

/** Fixed registrations: `popup-sentinel`, `popup-shim`, `popup-strict` over the list Strict sites, and `gpc` (`<all_urls>`). */
export function fixedReserve(listStrictSites: number): { readonly patterns: number; readonly registrations: number } {
  const GUARD_REGISTRATIONS = 3;
  return { patterns: GUARD_REGISTRATIONS * listStrictSites + 1, registrations: GUARD_REGISTRATIONS + 1 };
}

/** Every budget line `patterns` (pack → count) crosses; `fixed` patterns count against the enabled-together line. */
export function patternBudgetProblems(patterns: Readonly<Record<string, number>>, kinds: PackKinds, fixed = 0): readonly string[] {
  const entries = Object.entries(patterns);
  const sum = (pick: (pack: string) => boolean): number => entries.filter(([p]) => pick(p)).reduce((n, [, v]) => n + v, 0);
  const defaults = sum((p) => kinds.defaults.has(p));
  const optional = sum((p) => !kinds.defaults.has(p) && !kinds.regional.has(p));
  const regional = entries.filter(([p]) => kinds.regional.has(p));
  const largest = Math.max(0, ...regional.map(([, v]) => v));
  const enabled = defaults + optional + largest + fixed;
  return [
    ...(defaults > DEFAULT_PATTERN_BUDGET ? [`${String(defaults)} match patterns for the default packs > ${String(DEFAULT_PATTERN_BUDGET)}`] : []),
    ...(optional > OPTIONAL_NON_REGIONAL_PATTERN_BUDGET ? [`${String(optional)} match patterns for the optional non-regional packs > ${String(OPTIONAL_NON_REGIONAL_PATTERN_BUDGET)}`] : []),
    ...regional.filter(([, v]) => v > REGIONAL_PACK_PATTERN_BUDGET).map(([p, v]) => `${p}: ${String(v)} match patterns > ${String(REGIONAL_PACK_PATTERN_BUDGET)}`),
    ...(enabled > ENABLED_PATTERN_BUDGET ? [`${String(enabled)} match patterns for the default + every non-regional + the largest regional pack > ${String(ENABLED_PATTERN_BUDGET)}`] : []),
  ];
}

const GENERIC_FILE = /^cosmetic\/[a-z0-9-]+\/generic\.js$/;

/** Generic data files over the per-pack cap. */
export function genericSizeProblems(files: ReadonlyMap<string, string>): readonly string[] {
  return [...files].filter(([path]) => GENERIC_FILE.test(path)).flatMap(([path, text]) => {
    const size = Buffer.byteLength(text);
    return size > GENERIC_PACK_MAX_BYTES ? [`${path}: ${String(size)} B > ${String(GENERIC_PACK_MAX_BYTES)} (generic data per pack)`] : [];
  });
}

/** Script bytes the registrations name: `summed` counts a file once per registration (what Chrome stores), `unique` once. */
export function scriptBytes(registrations: readonly CatalogRegistration[], sizeOf: (path: string) => number): { readonly summed: number; readonly unique: number } {
  const paths = registrations.flatMap((r) => r.js);
  return { summed: paths.reduce((n, p) => n + sizeOf(p), 0), unique: [...new Set(paths)].reduce((n, p) => n + sizeOf(p), 0) };
}
