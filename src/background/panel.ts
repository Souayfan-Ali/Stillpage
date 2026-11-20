/**
 * The toolbar panel's two messages (P1-41, architecture notes §7): `q/tabState` and `c/setSiteLevel`. The panel
 * names its tab by id (it got it from `tabs.query({active, currentWindow})` in its own page); the
 * worker reads that tab's address with `tabs.get`, which needs no `tabs` permission and reports the
 * address only with host access to it (ADR-007). No tab events (ADR-001/012). A level change is a
 * serialised read–change–write of the vault, then one reconcile, answered as soon as its DNR rules
 * are in (D-25: `applying`); the registrations finish in the same run.
 */
import { withSiteLevel, type SiteLevelChoice } from '../core/levels/siteLevel.js';
import type { Hostname } from '../core/ids.js';
import type { Logger } from '../core/log.js';
import type { MessageError, Response } from '../core/messaging/parse.js';
import { describeTab, type LastRun, type TabState } from '../core/messaging/tabState.js';
import { chosenPacks } from '../core/reconcile/packChoice.js';
import { isGuardShipped } from './popupInputs.js';
import { siteSnapshotOf, withPause, type PauseChoice, type SiteSnapshot } from '../core/state/site.js';
import type { Settings } from '../core/state/types.js';
import { readUserFilters, USER_FILTERS_KEY } from '../core/userFilters/store.js';
import type { Ports } from '../platform/ports.js';
import { LAST_KEY, type EarlyOutcome, type Reconciler } from './reconciler.js';
import { dismissNotice as markDismissed, isNoticeShown, NOTICE_KEY, type SettingsStore } from './settingsStore.js';

export interface PanelContext {
  readonly ports: Ports;
  readonly store: SettingsStore;
  readonly reconciler: Reconciler;
}

export type ReconcileSummary = Pick<EarlyOutcome, 'status' | 'skippedPacks'>;

/** A site command's answer: the summary plus the host's own values as stored (design review, P2-14: no second read). */
export interface SiteSummary extends ReconcileSummary {
  readonly site: SiteSnapshot;
}

/** Thrown inside a settings update when the change would cross a site cap; nothing is stored. */
export class OverCap extends Error {}

/** D-31: `none` before the first run of this session, `failed` while the last one failed. */
function lastRunOf(last: unknown): LastRun {
  if (last === undefined) return 'none';
  return typeof last === 'object' && last !== null && (last as { status?: unknown }).status === 'failed' ? 'failed' : 'ok';
}

const failure = (code: MessageError['code'], message: string): Response<never> => ({ ok: false, error: { code, message } });

function internal(log: Logger, what: string, error: unknown): Response<never> {
  log.error(`${what} failed`, error);
  return failure('internal', `${what} failed`);
}

export async function tabState(tabId: number, ctx: PanelContext): Promise<Response<TabState>> {
  const { ports, store } = ctx;
  try {
    const now = ports.now();
    // Settings first: reading a corrupted value records the reset notice read just below.
    const loaded = await store.read(now);
    const [tab, grants, last, notice, packs, filters] = await Promise.all([
      ports.tabs.get(tabId),
      ports.permissions.getGrants(),
      ports.session.get(LAST_KEY),
      ports.vault.get(NOTICE_KEY),
      ports.catalog.readPacks(),
      ports.vault.get(USER_FILTERS_KEY),
    ]);
    if (tab === null) return failure('not-found', 'no such tab');
    if (loaded.isUnreadable) return failure('internal', 'settings could not be read');
    const facts = { url: tab.url, settings: loaded.settings, grants, ready: last !== undefined, settingsReset: isNoticeShown(notice), lastRun: lastRunOf(last), packs: chosenPacks(loaded.settings, { packs }), popupGuard: isGuardShipped(), userFilters: readUserFilters(filters), now };
    return { ok: true, data: describeTab(facts) };
  } catch (error) {
    return internal(ports.log, 'q/tabState', error);
  }
}

/**
 * Stores one site change, then answers once the run's DNR rules are in (D-25) with the host's own
 * values as stored. `change` may throw `OverCap` (refused, nothing stored).
 */
export async function applySiteChange(host: Hostname, what: string, change: (settings: Settings, now: number) => Settings, ctx: PanelContext): Promise<Response<SiteSummary>> {
  const { ports, store, reconciler } = ctx;
  try {
    await store.update((settings) => change(settings, ports.now()), ports.now());
  } catch (error) {
    if (error instanceof OverCap) return failure('invalid-payload', `${what}: too many sites`);
    return internal(ports.log, what, error);
  }
  const { status, skippedPacks } = await reconciler.requestEarly('command');
  if (status === 'failed') return failure('internal', 'saved, but applying it failed');
  try {
    const now = ports.now();
    const site = siteSnapshotOf((await store.read(now)).settings, host, now);
    return { ok: true, data: { status, skippedPacks, site } };
  } catch (error) {
    return internal(ports.log, what, error);
  }
}

export function setSiteLevel(host: Hostname, choice: SiteLevelChoice, ctx: PanelContext): Promise<Response<SiteSummary>> {
  return applySiteChange(host, 'c/setSiteLevel', (settings, now) => withSiteLevel(settings, host, choice, now), ctx);
}

/** `c/pauseSite` (P2-10): 30 / 60 minutes, or `null` for Off until turned back on. */
export function pauseSite(host: Hostname, choice: PauseChoice, ctx: PanelContext): Promise<Response<SiteSummary>> {
  return applySiteChange(
    host,
    'c/pauseSite',
    (settings, now) => {
      const next = withPause(settings, host, choice, now);
      if (next === null) throw new OverCap();
      return next;
    },
    ctx,
  );
}

/**
 * `c/dismissNotice` (D-32): the user has seen the settings-reset notice. Only this command hides it;
 * a settings write never hides a waiting notice.
 */
export async function dismissNotice(ctx: PanelContext): Promise<Response<{ readonly dismissed: true }>> {
  try {
    await markDismissed(ctx.ports.vault, ctx.ports.now());
    return { ok: true, data: { dismissed: true } };
  } catch (error) {
    return internal(ctx.ports.log, 'c/dismissNotice', error);
  }
}
