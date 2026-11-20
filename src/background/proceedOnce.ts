/**
 * `c/proceedOnce` (P2-55, pop-up notes §6.2; design review; security review of P2-55). Only `blocked.html` as a
 * tab's top frame; the host is re-parsed from the sender's own URL fragment and must equal the payload,
 * be a listed pop-up destination, and the redirect must be live (`<all_urls>` granted). One session
 * `allow` rule per (tab, host) for the tab's lifetime; rules of tabs that no longer exist are pruned
 * here. A host whose redirect is live in the lift band (D-55 / D-55a) gets the exact-URL rule at
 * 5,000,001 instead, built from the fragment's address; one it cannot name is refused. Serialised; every
 * failure answers `ok: false`.
 */
import { parseBlockedFragment } from '../core/blocked/fragment.js';
import { isProceedOnceRule, liftedProceedOnceRule, proceedOnceRule } from '../core/blocked/proceed.js';
import type { BlockedTarget } from '../core/blocked/fragment.js';
import type { MessageError, Response } from '../core/messaging/parse.js';
import type { SenderInfo } from '../core/messaging/sender.js';
import { hasAllSitesAccess } from '../core/reconcile/hostAccess.js';
import { isLiftedLive } from '../core/reconcile/popups.js';
import type { DnrRule } from '../core/reconcile/types.js';
import type { Ports } from '../platform/ports.js';
import { ownPagePath, senderTabId } from './senders.js';

type Done = Response<null>;
const fail = (code: MessageError['code'], message: string): Done => ({ ok: false, error: { code, message } });

export interface ProceedOnce {
  readonly handle: (payload: { readonly hostname: string }, sender: SenderInfo) => Promise<Done>;
}

/** Rules to remove: this tab's rule for the host (replaced) and rules of tabs that are gone. */
async function stale(ports: Ports, rules: readonly DnrRule[], tabId: number, host: string): Promise<readonly number[]> {
  const ids = await Promise.all(rules.filter(isProceedOnceRule).map(async (r) => {
    const tab = r.condition.tabIds?.[0] ?? -1;
    const same = tab === tabId && r.condition.requestDomains?.[0] === host;
    return same || (await ports.tabs.get(tab)) === null ? [r.id] : [];
  }));
  return ids.flat();
}

/** The exact-URL rule on a lifted host, else the host + tab rule (D-55a item 2). */
function ruleFor(target: BlockedTarget, lifted: boolean, tabId: number, usedIds: readonly number[]): DnrRule | null {
  return lifted ? liftedProceedOnceRule(target.url, target.host, tabId, usedIds) : proceedOnceRule(target.host, tabId, usedIds);
}

export function createProceedOnce(ports: Ports, runtimeId: string, destinations: () => Promise<readonly string[]>): ProceedOnce {
  let queue: Promise<unknown> = Promise.resolve();
  const run = async (payload: { readonly hostname: string }, sender: SenderInfo): Promise<Done> => {
    const tabId = senderTabId(sender);
    if (ownPagePath(sender, runtimeId) !== '/blocked.html' || sender.frameId !== 0 || tabId === null || sender.url === undefined) {
      return fail('forbidden-sender', 'only the blocked page');
    }
    const target = parseBlockedFragment(new URL(sender.url).hash);
    if (target?.host !== payload.hostname) return fail('forbidden-sender', 'host does not match the page');
    const [grants, listed] = await Promise.all([ports.permissions.getGrants(), destinations()]);
    if (!hasAllSitesAccess(grants) || !listed.includes(target.host)) return fail('not-found', 'not a listed destination');
    const [rules, lifted] = await Promise.all([ports.dnr.getSessionRules(), ports.dnr.getDynamicRules().then((d) => isLiftedLive(d, target.host))]);
    const remove = await stale(ports, rules, tabId, target.host);
    const rule = ruleFor(target, lifted, tabId, rules.map((r) => r.id).filter((id) => !remove.includes(id)));
    if (rule === null) return lifted ? fail('invalid-payload', 'this address cannot be allowed once') : fail('internal', 'too many open exceptions');
    await ports.dnr.updateSessionRules({ removeRuleIds: remove, addRules: [rule] });
    return { ok: true, data: null };
  };
  return {
    handle: (payload, sender) => {
      const next = queue.then(() => run(payload, sender)).catch((error: unknown) => {
        ports.log.warn('proceed once failed', error);
        return fail('internal', 'could not allow this site');
      });
      queue = next;
      return next;
    },
  };
}
