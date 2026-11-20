/**
 * `catalog.json` (filter-pipeline notes §9, P1-26): the packaged description the worker's `computeDesired` reads.
 * It records ceilings, never per-build counts, so it can stay fixed across ruleset releases. Shape:
 * `src/core/catalog/types.ts` (validated there by `readCatalog`).
 */
import type { ListsConfig } from '../config/schema.js';
import type { Slot } from '../postpass/budgets.js';

type LicenceState = 'cleared' | 'owner-pending';

/** A pack is owner-pending when any of its lists is (D-16). */
function licenceOf(config: ListsConfig, pack: string): LicenceState {
  const lists = new Set(config.rulesets.filter((r) => r.pack === pack).flatMap((r) => r.lists));
  const pending = config.lists.some((l) => lists.has(l.id) && l.licenceState === 'owner-pending');
  return pending ? 'owner-pending' : 'cleared';
}

/**
 * The catalog value (key order fixed: config order). When the config says so
 * (`content.catalogRegistrations`, on since P1-35) it names `registrations.json`, which holds the
 * shard registrations and the `$generichide` hosts, with that file's SHA-256 (D-26); packs carry no
 * inline registrations. A pack with generic cosmetic data is flagged `generic: true` (P2-25).
 */
export function catalogOf(
  config: ListsConfig,
  slots: readonly Slot[],
  registrations?: { readonly path: string; readonly sha256: string },
  genericPacks: ReadonlySet<string> = new Set(),
): unknown {
  const rulesets = Object.fromEntries(slots.map((s) => [s.id, { needsHostAccess: s.unsafe, maxRules: s.budget.rules, maxRegex: s.budget.regex }]));
  const packs = Object.fromEntries(Object.entries(config.packs).map(([id, p]) => [id, {
    rulesets: slots.filter((s) => s.pack === id).map((s) => s.id),
    default: p.default,
    licence: licenceOf(config, id),
    // P2-25: the pack ships `cosmetic/<pack>/generic.js` (path from `genericDataPath`).
    ...(genericPacks.has(id) && { generic: true }),
  }]));
  return { schema: 1, ...(registrations && { registrations }), rulesets, packs };
}
