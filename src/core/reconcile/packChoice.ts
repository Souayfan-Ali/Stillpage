/**
 * The user's pack choice (P2-26, filter-pipeline notes §8): which packs may be toggled, the settings after a toggle,
 * and whether an enabled pack would be left out of the desired state. Pure.
 */
import type { Catalog } from '../catalog/types.js';
import type { PackId } from '../ids.js';
import { own } from '../record.js';
import type { Settings } from '../state/types.js';
import type { DesiredState, SkippedPack } from './types.js';

/**
 * Packs that follow other settings, not the pack toggle. `popups` (known pop-up destinations) is on at
 * every level; the user's exemption is "Allow pop-ups on this site" (ADR-015 item 7, ADR-016).
 */
const NOT_USER_TOGGLEABLE: ReadonlySet<string> = new Set(['popups', 'gpc']);

/** The cookie pack follows `cookieBanners` (design review 2026-11-14): one source of truth; P3's `reject` keeps it on. */
const COOKIES = 'cookies';
/** The GPC pack follows `settings.gpc`; `c/setGpc` is its command. */
const GPC = 'gpc';

/** Packs whose value is mostly generic cosmetics: enabling one offers Thorough (ADR-015 item 5). */
const OFFERS_THOROUGH: ReadonlySet<string> = new Set([COOKIES]);

/** True when `pack` is on for these settings. */
export function isPackEnabled(settings: Settings, pack: PackId, catalogDefault: boolean): boolean {
  if (pack === COOKIES) return settings.cookieBanners !== 'leave';
  if (pack === GPC) return settings.gpc;
  return own(settings.packs, pack) ?? catalogDefault;
}

/** True when enabling `pack` should offer Thorough: it benefits, Thorough is not the default, all sites are granted. */
export function offersThorough(settings: Settings, pack: PackId, allSites: boolean): boolean {
  return OFFERS_THOROUGH.has(pack) && settings.defaultLevel !== 'thorough' && allSites;
}

/** Why `pack` cannot be toggled in this build, or `null` when it can. */
export function packRefusal(catalog: Catalog, pack: PackId): 'not-found' | 'not-toggleable' | null {
  if (own(catalog.packs, pack) === undefined) return 'not-found';
  return NOT_USER_TOGGLEABLE.has(pack) ? 'not-toggleable' : null;
}

/** Packs the user has on (explicit choice, else the catalog default), in catalog order (the breakage report, P2-15). */
export function chosenPacks(settings: Settings, catalog: { readonly packs: Readonly<Record<PackId, { readonly default: boolean }>> }): readonly PackId[] {
  return (Object.keys(catalog.packs) as PackId[]).filter((id) => isPackEnabled(settings, id, own(catalog.packs, id)?.default === true));
}

/** `settings` with the explicit choice for `pack`. Returns a new object. */
export function withPack(settings: Settings, pack: PackId, enabled: boolean): Settings {
  if (pack === COOKIES) return { ...settings, cookieBanners: enabled ? 'hide' : 'leave' };
  return { ...settings, packs: { ...settings.packs, [pack]: enabled } };
}

/** The skip that keeps `pack` out of `desired`, or `null` when it is in. */
export function skipOf(desired: DesiredState, pack: PackId): SkippedPack | null {
  return desired.skippedPacks.find((s) => s.pack === pack) ?? null;
}
