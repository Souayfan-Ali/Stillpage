/**
 * The settings pages' messages (P2-33…P2-36): `q/dashboard` (one snapshot, design review 2026-11-14, with the
 * hidden-items list since P2-22),
 * `c/setDefaultLevel`, `c/forgetSites`, `c/setShowBadge` and `c/completeOnboarding`. Each command is a serialised read–change–write of the vault; the ones that
 * change what Chrome enforces then reconcile. Which page may send which is in `messages.ts`.
 */
import type { Hostname } from '../core/ids.js';
import type { PackId } from '../core/ids.js';
import type { DashboardAnswer } from '../core/messaging/dashboardSchema.js';
import { packRefusal } from '../core/reconcile/packChoice.js';
import type { MessageError, Response } from '../core/messaging/parse.js';
import { computeDesired, DEFAULT_DESIRED_LIMITS } from '../core/reconcile/computeDesired.js';
import { hasAllSitesAccess } from '../core/reconcile/hostAccess.js';
import { withoutSites } from '../core/state/sites.js';
import type { DefaultLevel, Settings } from '../core/state/types.js';
import { isUnreadableStore, readUserFilters, USER_FILTERS_KEY } from '../core/userFilters/store.js';
import { applyBadge } from './firstRun.js';
import type { PanelContext, ReconcileSummary } from './panel.js';
import { isGuardShipped } from './popupInputs.js';
import { LAST_KEY, readCapacity } from './reconciler.js';
import { isNoticeShown, NOTICE_KEY } from './settingsStore.js';

const failure = (code: MessageError['code'], message: string): Response<never> => ({ ok: false, error: { code, message } });

function lastRunOf(last: unknown): DashboardAnswer['lastRun'] {
  if (last === undefined) return 'none';
  return typeof last === 'object' && last !== null && (last as { status?: unknown }).status === 'failed' ? 'failed' : 'ok';
}

/** `q/dashboard`: the settings with each pack's state, the capacity numbers and the notices. */
export async function dashboardState(ctx: PanelContext): Promise<Response<DashboardAnswer>> {
  const { ports, store } = ctx;
  try {
    const now = ports.now();
    const loaded = await store.read(now);
    if (loaded.isUnreadable) return failure('internal', 'settings could not be read');
    const [catalog, grants, enabledRulesets, available, last, notice, filters] = await Promise.all([
      ports.catalog.read(),
      ports.permissions.getGrants(),
      ports.dnr.getEnabledRulesets(),
      readCapacity(ports),
      ports.session.get(LAST_KEY),
      ports.vault.get(NOTICE_KEY),
      ports.vault.get(USER_FILTERS_KEY),
    ]);
    const context = available === null ? {} : { capacity: { available, enabled: enabledRulesets } };
    const { skippedPacks } = computeDesired(loaded.settings, grants, catalog, now, DEFAULT_DESIRED_LIMITS, context);
    const packs = Object.entries(catalog.packs).map(([id, p]) => ({ id, default: p.default, toggleable: packRefusal(catalog, id as PackId) === null, licence: p.licence, rulesets: [...p.rulesets] }));
    const ceilings = Object.fromEntries(Object.entries(catalog.rulesets).map(([id, r]) => [id, r.maxRules]));
    const skipped = skippedPacks.map(({ pack, reason }) => ({ pack, reason }));
    const flags = { allSites: hasAllSitesAccess(grants), popupGuard: isGuardShipped(), settingsReset: isNoticeShown(notice), lastRun: lastRunOf(last) };
    const userFilters = isUnreadableStore(filters) ? null : readUserFilters(filters).hosts;
    return { ok: true, data: { settings: loaded.settings, packs, ceilings, enabledRulesets: [...enabledRulesets], available, skipped, ...flags, userFilters } };
  } catch (error) {
    ports.log.error('q/dashboard failed', error);
    return failure('internal', 'q/dashboard failed');
  }
}

/** Stores one change; reconciles when `reconcile` is set. */
async function change(what: string, next: (settings: Settings) => Settings, reconcile: boolean, ctx: PanelContext): Promise<Response<ReconcileSummary>> {
  try {
    await ctx.store.update(next, ctx.ports.now());
  } catch (error) {
    ctx.ports.log.error(`${what} failed`, error);
    return failure('internal', `${what} failed`);
  }
  if (!reconcile) return { ok: true, data: { status: 'unchanged', skippedPacks: [] } };
  const { status, skippedPacks } = await ctx.reconciler.request('command');
  return status === 'failed' ? failure('internal', `${what}: saved, but applying it failed`) : { ok: true, data: { status, skippedPacks } };
}

export function setDefaultLevel(level: DefaultLevel, ctx: PanelContext): Promise<Response<ReconcileSummary>> {
  return change('c/setDefaultLevel', (s) => ({ ...s, defaultLevel: level }), true, ctx);
}

/** Sites section bulk remove (P2-35): level, pause and pop-up policy of each host, in one write. */
export function forgetSites(hosts: readonly Hostname[], ctx: PanelContext): Promise<Response<ReconcileSummary>> {
  return change('c/forgetSites', (s) => withoutSites(s, hosts), true, ctx);
}

/** Badge on/off (P2-36, UI notes §8): stored, then Chrome's action count follows it (no reconcile). */
export async function setShowBadge(enabled: boolean, ctx: PanelContext): Promise<Response<ReconcileSummary>> {
  const result = await change('c/setShowBadge', (s) => ({ ...s, ui: { ...s.ui, showBadge: enabled } }), false, ctx);
  if (result.ok) await applyBadge(ctx.ports, enabled);
  return result;
}

/** Finish or skip on the first-run page (P2-33); closing the tab sets nothing (design review, D-46). */
export function completeOnboarding(ctx: PanelContext): Promise<Response<ReconcileSummary>> {
  const now = ctx.ports.now();
  return change('c/completeOnboarding', (s) => ({ ...s, onboarding: { completedAt: now } }), false, ctx);
}
