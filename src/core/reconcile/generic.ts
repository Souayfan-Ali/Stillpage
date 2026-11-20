/**
 * The `cosmetic-generic` registration (P2-25, architecture notes §9, cosmetic notes §5; design review 2026-11-14): the Thorough
 * surveyor, registered only where Thorough is in use — on the roots explicitly raised to Thorough, or
 * `<all_urls>` when Thorough is the default. ISOLATED, `document_idle`, every frame. `js` lists the
 * generic data files of the packs that are actually on (selected, not skipped), in catalog order, then
 * the surveyor. `excludeMatches`: Standard-or-below roots inside the scope (Off, Light, Standard and
 * paused subtrees) and the `$generichide` hosts; the surveyor checks the latter again for frames reached
 * by `matchOriginAsFallback`. A build without the `$generichide` list gets no registration (fail closed).
 * Like every registration, `matches` never depends on grants (S-10).
 * Known difference (as for `gpc`): `matches` is tested on each frame's own URL, so a third-party frame on
 * a Thorough site is surveyed only when its own host is in scope. Levels are monotone down the domain
 * tree (`resolveLevel`), so a host set to Thorough under a lower parent is not Thorough, and excluding
 * the parent's subtree is exact.
 */
import type { Catalog } from '../catalog/types.js';
import { genericDataPath } from '../generic/data.js';
import { isSameOrSubdomain } from '../hostname/walk.js';
import type { Hostname, PackId } from '../ids.js';
import { rootsAtOrAbove, rootsAtOrBelow } from '../levels/roots.js';
import type { EpochMs, Settings } from '../state/types.js';
import { isPackEnabled } from './packChoice.js';
import { hostPattern } from './registrations.js';
import type { ScriptRegistration } from './types.js';

/** Packaged surveyor (WXT unlisted, `src/entrypoints/cosmetic-generic.ts`). */
export const GENERIC_SURVEYOR = 'cosmetic-generic.js';
export const GENERIC_REGISTRATION_ID = 'cosmetic-generic';
const ALL_URLS = '<all_urls>';

/** Where the surveyor runs, before the packs are known (so the limits can reserve its patterns). */
export interface GenericScope {
  readonly matches: readonly string[];
  readonly excludeMatches: readonly string[];
}

const inside = (host: Hostname, roots: readonly Hostname[]): boolean => roots.some((root) => isSameOrSubdomain(host, root));
const touches = (host: Hostname, roots: readonly Hostname[]): boolean => roots.some((root) => isSameOrSubdomain(host, root) || isSameOrSubdomain(root, host));

/** The surveyor's scope, or `null` when Thorough is not in use or the build has no `$generichide` list. */
export function genericScope(settings: Settings, catalog: Catalog, now: EpochMs): GenericScope | null {
  const off = catalog.genericOff;
  // Nothing is reserved unless a pack with generic data is on (review LOW: no wasted registration).
  if (off === null || !Object.entries(catalog.packs).some(([id, p]) => p.generic && isPackEnabled(settings, id as PackId, p.default))) return null;
  const lowered = rootsAtOrBelow(settings, now, 'standard');
  if (settings.defaultLevel === 'thorough') {
    return { matches: [ALL_URLS], excludeMatches: [...new Set([...lowered, ...off])].map(hostPattern).sort() };
  }
  const roots = rootsAtOrAbove(settings, now, 'thorough');
  if (roots.length === 0) return null;
  const excluded = [...lowered.filter((h) => inside(h, roots) && !roots.includes(h)), ...off.filter((h) => touches(h, roots))];
  return { matches: roots.map(hostPattern).sort(), excludeMatches: [...new Set(excluded)].map(hostPattern).sort() };
}

/** The registration for `scope` with the data files of `packs` (the enabled ones, in catalog order). */
export function genericRegistration(scope: GenericScope | null, catalog: Catalog, packs: readonly PackId[]): readonly ScriptRegistration[] {
  const files = packs.filter((id) => Object.hasOwn(catalog.packs, id) && catalog.packs[id]?.generic === true).map(genericDataPath);
  if (scope === null || files.length === 0) return [];
  return [{
    id: GENERIC_REGISTRATION_ID,
    world: 'ISOLATED',
    js: [...files, GENERIC_SURVEYOR],
    matches: [...scope.matches],
    excludeMatches: [...scope.excludeMatches],
    runAt: 'document_idle',
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
  }];
}
