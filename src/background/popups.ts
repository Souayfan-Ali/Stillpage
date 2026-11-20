/**
 * `c/setPopupMode` and `c/setSitePopupPolicy` (P2-54, architecture notes §7, pop-up notes §11). Persistent pop-up
 * choices come only from settings pages (never a content script, never `blocked.html`; checked in
 * `messages.ts`). Each is a serialised read–change–write of the vault, then one reconcile. A site
 * policy changes only `excludeMatches` and the opener `allow` rule, so it answers once the rules are in
 * (D-25), like a site level.
 */
import type { Hostname } from '../core/ids.js';
import type { MessageError, Response } from '../core/messaging/parse.js';
import { withPopupMode, withPopupNotice, withSitePopupPolicy, type SitePopupChoice } from '../core/state/popups.js';
import type { PopupMode } from '../core/state/types.js';
import { applySiteChange, OverCap, type PanelContext, type ReconcileSummary, type SiteSummary } from './panel.js';

const failure = (code: MessageError['code'], message: string): Response<never> => ({ ok: false, error: { code, message } });

async function apply(what: string, early: boolean, ctx: PanelContext): Promise<Response<ReconcileSummary>> {
  const { status, skippedPacks } = await (early ? ctx.reconciler.requestEarly('command') : ctx.reconciler.request('command'));
  return status === 'failed' ? failure('internal', `${what}: saved, but applying it failed`) : { ok: true, data: { status, skippedPacks } };
}

export async function setPopupMode(mode: PopupMode, ctx: PanelContext): Promise<Response<ReconcileSummary>> {
  try {
    await ctx.store.update((settings) => withPopupMode(settings, mode), ctx.ports.now());
  } catch (error) {
    ctx.ports.log.error('c/setPopupMode failed', error);
    return failure('internal', 'c/setPopupMode failed');
  }
  return apply('c/setPopupMode', false, ctx);
}

/** `c/setPopupNotice` (P2-60b): stored, then one reconcile; off registers the `popup-quiet` flag wherever the sentinel runs (P2-59). */
export async function setPopupNotice(enabled: boolean, ctx: PanelContext): Promise<Response<ReconcileSummary>> {
  try {
    await ctx.store.update((settings) => withPopupNotice(settings, enabled), ctx.ports.now());
  } catch (error) {
    ctx.ports.log.error('c/setPopupNotice failed', error);
    return failure('internal', 'c/setPopupNotice failed');
  }
  return apply('c/setPopupNotice', false, ctx);
}

export function setSitePopupPolicy(host: Hostname, choice: SitePopupChoice, ctx: PanelContext): Promise<Response<SiteSummary>> {
  return applySiteChange(
    host,
    'c/setSitePopupPolicy',
    (settings) => {
      const next = withSitePopupPolicy(settings, host, choice);
      if (next === null) throw new OverCap();
      return next;
    },
    ctx,
  );
}
