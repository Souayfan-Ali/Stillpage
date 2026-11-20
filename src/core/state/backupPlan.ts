/**
 * What restoring a backup will do (P2-37, design review 2026-11-14): the settings to store and the packs left
 * out; the page words the differences itself (`backupChanges.ts`), which keeps the worker small. A pack
 * this build does not have (or one the user cannot toggle) and a pack that does not fit Chrome's limits
 * now are dropped with a line in the preview, like `c/setPack` refuses them (P2-26: refused and not stored). The worker computes this twice, for
 * the preview and again from scratch for the import. Pure.
 */
import type { Catalog } from '../catalog/types.js';
import type { PackId } from '../ids.js';
import { packRefusal, withPack } from '../reconcile/packChoice.js';
import type { SkippedPack } from '../reconcile/types.js';
import { withBackup, type BackupSettings } from './backup.js';
import type { Dropped } from './backupPreview.js';
import type { Settings } from './types.js';

export interface RestorePlan {
  readonly settings: Settings;
  readonly dropped: readonly Dropped[];
}

/** Packs the backup names that this build cannot take (unknown, or following another setting). */
function unavailablePacks(backup: BackupSettings, catalog: Catalog): readonly PackId[] {
  return (Object.keys(backup.packs) as PackId[]).filter((pack) => packRefusal(catalog, pack) !== null);
}

function withoutPacks(settings: Settings, packs: readonly PackId[]): Settings {
  const drop = new Set<string>(packs);
  return { ...settings, packs: Object.fromEntries(Object.entries(settings.packs).filter(([id]) => !drop.has(id))) };
}

/**
 * Plans restoring `backup` over `current`. `skippedOf` runs the capacity check on candidate settings
 * (the reconciler's `computeDesired` with Chrome's numbers) and returns the packs it would leave out.
 */
export function planRestore(current: Settings, backup: BackupSettings, catalog: Catalog, skippedOf: (settings: Settings) => readonly SkippedPack[]): RestorePlan {
  const unavailable = unavailablePacks(backup, catalog);
  const candidate = withoutPacks(withBackup(current, backup), unavailable);
  const skipped = skippedOf(candidate).filter((s) => packRefusal(catalog, s.pack) === null);
  const settings = skipped.reduce((s, skip) => withPack(s, skip.pack, false), candidate);
  const dropped: Dropped[] = [...unavailable.map((pack): Dropped => ({ pack, reason: packRefusal(catalog, pack) === 'not-found' ? 'unavailable' : 'not-toggleable' })), ...skipped.map((s): Dropped => ({ pack: s.pack, reason: s.reason }))];
  return { settings, dropped };
}
