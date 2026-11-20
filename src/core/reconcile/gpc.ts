/**
 * The GPC property script (P2-31): `navigator.globalPrivacyControl === true` in every frame while GPC is
 * on, beside the `Sec-GPC: 1` header of `gpc-x`. Excluded on Off and paused subtrees only (design review,
 * 2026-11-14: a privacy signal, not filtering, so it stays on Light, where the header also applies).
 * Known difference: `excludeMatches` is per frame URL, so a third-party frame on an Off site gets the
 * property but not the header (`allowAllRequests` covers the whole frame tree).
 */
import type { Catalog } from '../catalog/types.js';
import type { PackId } from '../ids.js';
import { rootsAtOrBelow } from '../levels/roots.js';
import { own } from '../record.js';
import type { EpochMs, Settings } from '../state/types.js';
import { hostPattern } from './registrations.js';
import type { ScriptRegistration } from './types.js';

/** Packaged MAIN-world script (WXT unlisted, `src/entrypoints/gpc.ts`). */
export const GPC_SCRIPT = 'gpc.js';
const GPC_PACK = 'gpc' as PackId;

/** The `gpc` registration, or none when GPC is off or the build has no GPC pack. */
export function gpcRegistrations(settings: Settings, catalog: Catalog, now: EpochMs): readonly ScriptRegistration[] {
  if (!settings.gpc || own(catalog.packs, GPC_PACK) === undefined) return [];
  return [{
    id: 'gpc',
    world: 'MAIN',
    js: [GPC_SCRIPT],
    matches: ['<all_urls>'],
    excludeMatches: rootsAtOrBelow(settings, now, 'off').map(hostPattern).sort(),
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
  }];
}
