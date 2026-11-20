/**
 * `q/previewBackup` and `c/importBackup` (P2-37, security notes T12, design review 2026-11-14). Both read the file
 * text from scratch (size cap, JSON, strict schema) and plan the restore against the current settings
 * and Chrome's limits; the import never trusts the preview the page saw. After the settings are stored,
 * the settings-reset notice is cleared (D-32): a failed import leaves it visible. Format version 2
 * (P2-22) may carry the user filters: they replace the device's, through the user filter service (vault,
 * then mirror); the digest covers them as they are now and as they will be.
 */
import type { MessageError, Response } from '../core/messaging/parse.js';
import { computeDesired, DEFAULT_DESIRED_LIMITS } from '../core/reconcile/computeDesired.js';
import type { SkippedPack } from '../core/reconcile/types.js';
import { readBackup, type Backup, type BackupProblem } from '../core/state/backup.js';
import { deviceHostsOf, withoutSuffixHosts } from '../core/state/backupHosts.js';
import { planRestore, type RestorePlan } from '../core/state/backupPlan.js';
import type { Dropped } from '../core/state/backupPreview.js';
import type { Settings } from '../core/state/types.js';
import type { UserFilters } from '../core/userFilters/store.js';
import type { Ports } from '../platform/ports.js';
import type { Features } from './features.js';
import { applyBadge } from './firstRun.js';
import type { PanelContext } from './panel.js';
import { readCapacity } from './reconciler.js';
import { NOTICE_KEY } from './settingsStore.js';

/** The router's context as the settings pages' handlers see it. */
export interface SettingsPageContext extends PanelContext {
  readonly features?: Features;
}

const failure = (code: MessageError['code'], message: string): Response<never> => ({ ok: false, error: { code, message } });

/** Thrown inside the settings update to abort the write. */
class Refused extends Error {}

/** The worker's capacity check for candidate settings, with Chrome's numbers read once. */
async function capacityCheck(ports: Ports): Promise<(settings: Settings) => readonly SkippedPack[]> {
  const [catalog, grants, enabled, available] = await Promise.all([ports.catalog.read(), ports.permissions.getGrants(), ports.dnr.getEnabledRulesets(), readCapacity(ports)]);
  const now = ports.now();
  const context = available === null ? {} : { capacity: { available, enabled } };
  return (settings) => computeDesired(settings, grants, catalog, now, DEFAULT_DESIRED_LIMITS, context).skippedPacks;
}

function problem(reason: BackupProblem): Response<never> {
  return failure('invalid-payload', `backup refused: ${reason}`);
}

/** The filters a restore replaces: `null` when the file carries none (kept as they are). */
interface FilterPlan {
  readonly before: UserFilters;
  readonly after: UserFilters;
}

interface FullPlan extends RestorePlan {
  readonly filters: FilterPlan | null;
}

/** Thrown when the device's filter store cannot be read: it is never overwritten (P2-20 review LOW-6). */
class Unreadable extends Error {}

/** The device's hidden items when the file carries some to replace them with; `null` when it carries none. */
async function deviceFilters(file: Backup, ctx: SettingsPageContext): Promise<UserFilters | null> {
  if (file.userFilters === null) return null;
  const before = await ctx.features?.userFilters.current();
  if (before === undefined || before === null) throw new Unreadable('the filter store cannot be read');
  return before;
}

async function planFor(file: Backup, current: Settings, ctx: SettingsPageContext): Promise<FullPlan> {
  const [catalog, skippedOf, before] = await Promise.all([ctx.ports.catalog.read(), capacityCheck(ctx.ports), deviceFilters(file, ctx)]);
  // Entries for a whole suffix never restore, unless a single label the device already holds there (D-62);
  // the preview names the rest (P2-43 security review A-1, design review).
  const { backup, hosts } = withoutSuffixHosts(file, deviceHostsOf(current, before));
  const filters: FilterPlan | null = before === null || backup.userFilters === null ? null : { before, after: backup.userFilters };
  const plan = planRestore(current, backup.settings, catalog, skippedOf);
  const suffix: readonly Dropped[] = hosts.length === 0 ? [] : [{ reason: 'suffix', hosts: [...hosts] }];
  return { ...plan, dropped: [...suffix, ...plan.dropped], filters };
}

/** SHA-256 (hex) of what a plan would store (and the filters it replaces): ties the import to the preview the user saw. */
async function digestOf(plan: FullPlan): Promise<string> {
  const text = JSON.stringify(plan.filters === null ? plan.settings : [plan.settings, plan.filters]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The preview answer: the settings now and after, the packs left out, the filters, and the plan's digest. */
interface PreviewAnswer {
  readonly before: Settings;
  readonly after: Settings;
  readonly dropped: readonly Dropped[];
  readonly filters: { readonly before: UserFilters['hosts']; readonly after: UserFilters['hosts'] } | null;
  readonly digest: string;
}

export async function previewBackup(json: string, ctx: SettingsPageContext): Promise<Response<PreviewAnswer>> {
  const read = readBackup(json);
  if (!read.ok) return problem(read.errors);
  try {
    const loaded = await ctx.store.read(ctx.ports.now());
    if (loaded.isUnreadable) return failure('internal', 'settings could not be read');
    const plan = await planFor(read.value, loaded.settings, ctx);
    const filters = plan.filters === null ? null : { before: plan.filters.before.hosts, after: plan.filters.after.hosts };
    return { ok: true, data: { before: loaded.settings, after: plan.settings, dropped: plan.dropped, filters, digest: await digestOf(plan) } };
  } catch (error) {
    ctx.ports.log.error('q/previewBackup failed', error);
    return failure('internal', 'q/previewBackup failed');
  }
}

/** D-32: a successful restore clears the settings-reset notice (shown or dismissed). */
async function clearNotice(ports: Ports): Promise<void> {
  try {
    await ports.vault.remove(NOTICE_KEY);
  } catch (error) {
    ports.log.error('could not clear the reset notice after a restore', error);
  }
}

/** What happened to the hidden items: replaced, kept because they changed meanwhile or could not be written, none in the file. */
type FiltersOutcome = 'replaced' | 'kept' | 'none';

/** The import's answer: what was restored, the packs left out, and the hidden items' outcome (design review, P2-22 Q4). */
interface ImportAnswer {
  readonly status: string;
  readonly dropped: readonly Dropped[];
  readonly filters: FiltersOutcome;
}

/** Plans again from scratch and stores the plan if it is still the one previewed and nothing changed meanwhile. */
async function storePlan(backup: Backup, expect: string, ctx: SettingsPageContext): Promise<FullPlan> {
  const { ports } = ctx;
  const before = await ctx.store.read(ports.now());
  if (before.isUnreadable) throw new Error('settings could not be read');
  const plan = await planFor(backup, before.settings, ctx).catch((error: unknown) => {
    throw error instanceof Unreadable ? new Refused(error.message) : error;
  });
  if ((await digestOf(plan)) !== expect) throw new Refused('not the previewed plan');
  await ctx.store.update((current) => {
    if (JSON.stringify(current) !== JSON.stringify(before.settings)) throw new Refused('settings changed during the import');
    return plan.settings;
  }, ports.now());
  return plan;
}

/**
 * Replaces the filters after the settings are stored. Nothing retries a replacement that did not happen
 * (the reconciler retries applying only), so it is answered `kept` and the page says so (design review Q4).
 */
async function storeFilters(plan: FullPlan, ctx: SettingsPageContext): Promise<FiltersOutcome> {
  if (plan.filters === null) return 'none';
  const replaced = (await ctx.features?.userFilters.replace(plan.filters.before, plan.filters.after)) ?? false;
  if (!replaced) ctx.ports.log.warn('backup restore: the hidden items changed meanwhile and were not replaced');
  return replaced ? 'replaced' : 'kept';
}

export async function importBackup(json: string, expect: string, ctx: SettingsPageContext): Promise<Response<ImportAnswer>> {
  const read = readBackup(json);
  if (!read.ok) return problem(read.errors);
  const { ports } = ctx;
  let plan: FullPlan;
  try {
    plan = await storePlan(read.value, expect, ctx);
  } catch (error) {
    // Settings, filters, grants or Chrome's room changed since the preview: the page previews again.
    if (error instanceof Refused) return failure('invalid-payload', 'stale preview');
    ports.log.error('c/importBackup failed', error);
    return failure('internal', 'c/importBackup failed');
  }
  const filters = await storeFilters(plan, ctx).catch((error: unknown): FiltersOutcome => {
    ports.log.error('backup restore: hidden items not stored', error);
    return 'kept';
  });
  await clearNotice(ports);
  await applyBadge(ports, plan.settings.ui.showBadge);
  // Stored either way: a failed run is answered `status: 'failed'` (the reconciler retries), not as "nothing restored".
  const { status } = await ctx.reconciler.request('command');
  return { ok: true, data: { status, dropped: plan.dropped, filters } };
}
