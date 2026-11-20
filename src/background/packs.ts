/**
 * `c/setPack` (P2-26, filter-pipeline notes §8). Disabling is stored and reconciled. Enabling is checked first against
 * Chrome's limits with the same `computeDesired` the reconciler runs, inside the settings write queue so
 * a concurrent command cannot slip in between: a pack that would be skipped is refused with an honest,
 * structured error and nothing is stored. The static rule pool is `getAvailableStaticRuleCount()`.
 */
import type { PackId } from '../core/ids.js';
import type { MessageError, Response } from '../core/messaging/parse.js';
import { computeDesired, DEFAULT_DESIRED_LIMITS } from '../core/reconcile/computeDesired.js';
import { hasAllSitesAccess } from '../core/reconcile/hostAccess.js';
import { offersThorough, packRefusal, skipOf, withPack } from '../core/reconcile/packChoice.js';
import type { SkippedPack } from '../core/reconcile/types.js';
import type { PanelContext, ReconcileSummary } from './panel.js';
import { readCapacity } from './reconciler.js';

const failure = (error: MessageError): Response<never> => ({ ok: false, error });

class NoCapacity extends Error {
  constructor(readonly skip: SkippedPack) {
    super(`pack ${skip.pack} does not fit: ${skip.reason} needs ${String(skip.needed)}, ${String(skip.available)} available`);
  }
}

/** Stores the choice; resolves whether the answer may offer Thorough (P2-27). */
async function store(pack: PackId, enabled: boolean, ctx: PanelContext): Promise<boolean> {
  const { ports } = ctx;
  const [catalog, grants, enabledRulesets, capacity] = await Promise.all([
    ports.catalog.read(),
    ports.permissions.getGrants(),
    ports.dnr.getEnabledRulesets(),
    readCapacity(ports),
  ]);
  const now = ports.now();
  const context = capacity === null ? {} : { capacity: { available: capacity, enabled: enabledRulesets } };
  let offer = false;
  await ctx.store.update((settings) => {
    const next = withPack(settings, pack, enabled);
    const skip = enabled ? skipOf(computeDesired(next, grants, catalog, now, DEFAULT_DESIRED_LIMITS, context), pack) : null;
    if (skip !== null) throw new NoCapacity(skip);
    offer = enabled && offersThorough(next, pack, hasAllSitesAccess(grants));
    return next;
  }, now);
  return offer;
}

async function refusal(pack: PackId, ctx: PanelContext): Promise<Response<never> | null> {
  const reason = packRefusal(await ctx.ports.catalog.read(), pack);
  if (reason === 'not-found') return failure({ code: 'not-found', message: `no pack ${pack} in this build` });
  return reason === null ? null : failure({ code: 'invalid-payload', message: `pack ${pack} is not user-toggleable` });
}

/** The `c/setPack` answer: the reconcile summary, and whether the page should offer Thorough. */
type PackAnswer = ReconcileSummary & { readonly offerThorough: boolean };

export async function setPack(pack: PackId, enabled: boolean, ctx: PanelContext): Promise<Response<PackAnswer>> {
  let offer: boolean;
  try {
    const refused = await refusal(pack, ctx);
    if (refused !== null) return refused;
    offer = await store(pack, enabled, ctx);
  } catch (error) {
    if (error instanceof NoCapacity) {
      const { reason, needed, available } = error.skip;
      return failure({ code: 'no-capacity', message: error.message, detail: { reason, needed, available } });
    }
    ctx.ports.log.error('c/setPack failed', error);
    return failure({ code: 'internal', message: 'c/setPack failed' });
  }
  const { status, skippedPacks } = await ctx.reconciler.request('command');
  if (status === 'failed') return failure({ code: 'internal', message: 'saved, but applying it failed' });
  // Offered only when the pack really ended enabled (not skipped by a limit).
  return { ok: true, data: { status, skippedPacks, offerThorough: offer && !skippedPacks.some((s) => s.pack === pack) } };
}

/** `c/setGpc` (P2-31): the GPC pack follows `settings.gpc` (one rule, one tiny script: no capacity check). */
export async function setGpc(enabled: boolean, ctx: PanelContext): Promise<Response<ReconcileSummary>> {
  try {
    await ctx.store.update((settings) => ({ ...settings, gpc: enabled }), ctx.ports.now());
  } catch (error) {
    ctx.ports.log.error('c/setGpc failed', error);
    return failure({ code: 'internal', message: 'c/setGpc failed' });
  }
  const { status, skippedPacks } = await ctx.reconciler.request('command');
  return status === 'failed' ? failure({ code: 'internal', message: 'saved, but applying it failed' }) : { ok: true, data: { status, skippedPacks } };
}
