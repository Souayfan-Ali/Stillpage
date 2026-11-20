/**
 * User filter store and its commands (P2-20, cosmetic notes §7, §9; design review; security review of P2-18/P2-19).
 * The vault holds the filters; `storage.local` holds an untrusted mirror (`uf:*`) that the
 * `user-cosmetic` script reads and that this module re-derives on every reconcile and daily. Order of a
 * change: vault, then mirror, then registration (a reconcile). Calls are serialised.
 */
import type { Hostname } from '../core/ids.js';
import { isProceedOnceRule } from '../core/blocked/proceed.js';
import { parseHostname } from '../core/hostname/validate.js';
import type { MessageError, Response } from '../core/messaging/parse.js';
import type { SenderInfo } from '../core/messaging/sender.js';
import { PICKER_CLAIMED_TTL_MS, PICKER_UNDO_MS, pickerSavedKey, pickerSessionKey, readPickerSession } from '../core/picker/session.js';
import type { DnrRule } from '../core/reconcile/types.js';
import { auditMirror } from '../core/userFilters/mirror.js';
import { addUserFilter, filterHostKey, filterHosts, isUnreadableStore, readUserFilters, removeUserFilter, USER_FILTERS_KEY, type UserFilters } from '../core/userFilters/store.js';
import type { Ports } from '../platform/ports.js';
import { isSettingsPage, panelTab } from './senders.js';

/** Daily mirror audit (architecture notes §6). */
export const USER_FILTER_AUDIT_ALARM = 'uf-audit';
const USER_FILTER_AUDIT_PERIOD_MS = 24 * 60 * 60_000;

type Done = Response<null>;
const fail = (code: MessageError['code'], message: string): Done => ({ ok: false, error: { code, message } });
const done: Done = { ok: true, data: null };

interface Saved { readonly key: Hostname; readonly hostname: Hostname; readonly selector: string; readonly at: number }

export interface UserFilterService {
  readonly save: (payload: { readonly hostname: string; readonly selector: string; readonly nonce: string }, sender: SenderInfo) => Promise<Done>;
  readonly remove: (payload: { readonly hostname: string; readonly selector: string }, sender: SenderInfo) => Promise<Done>;
  /** The store now; `null` when the vault holds a value this build cannot read. */
  readonly current: () => Promise<UserFilters | null>;
  /** Backup restore (P2-22): replaces the whole store, only while it still equals `before`; false otherwise. */
  readonly replace: (before: UserFilters, next: UserFilters) => Promise<boolean>;
  /** Re-derives the mirror and keeps the daily audit alarm set exactly while filters exist. */
  readonly audit: () => Promise<void>;
  /** For the reconciler: hosts with filters, and the "Proceed once" rules of tabs that still exist. */
  readonly reconcileInputs: (sessionRules: readonly DnrRule[]) => Promise<{ readonly userFilterHosts: readonly Hostname[]; readonly sessionRules: readonly DnrRule[] }>;
}

const readSaved = (raw: unknown): Saved | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<Record<keyof Saved, unknown>>;
  const [key, hostname] = [parseHostname(r.key), parseHostname(r.hostname)];
  return key === null || hostname === null || typeof r.selector !== 'string' || typeof r.at !== 'number' ? null : { key, hostname, selector: r.selector, at: r.at };
};

async function tabHost(ports: Ports, tabId: number): Promise<Hostname | null> {
  const tab = await ports.tabs.get(tabId);
  if (tab?.url === undefined || tab.url === null || !URL.canParse(tab.url)) return null;
  const url = new URL(tab.url);
  return url.protocol === 'https:' || url.protocol === 'http:' ? parseHostname(url.hostname) : null;
}

export function createUserFilterService(ports: Ports, runtimeId: string, requestReconcile: () => void): UserFilterService {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };
  /** The store, or `null` when the vault holds something this build cannot read: then nothing is rewritten (review LOW-6). */
  const read = async (): Promise<UserFilters | null> => {
    const raw = await ports.vault.get(USER_FILTERS_KEY);
    return isUnreadableStore(raw) ? null : readUserFilters(raw);
  };
  const audit = async (): Promise<void> => {
    const local = ports.user?.local;
    const store = await read();
    if (local === undefined || store === null) return;
    const plan = auditMirror(store, await local.getAll());
    if (Object.keys(plan.set).length > 0) await local.set(plan.set);
    if (plan.remove.length > 0) await local.remove(plan.remove);
    // No filters, no alarm: a profile without user filters gets no daily wake-up.
    await (filterHosts(store).length > 0
      ? ports.alarms.setAt(USER_FILTER_AUDIT_ALARM, ports.now() + USER_FILTER_AUDIT_PERIOD_MS)
      : ports.alarms.clear(USER_FILTER_AUDIT_ALARM));
  };
  const commit = async (next: UserFilters): Promise<void> => {
    await ports.vault.set(USER_FILTERS_KEY, next);
    await audit();
    requestReconcile();
  };

  const save: UserFilterService['save'] = (payload, sender) => serial(async () => {
    const tabId = panelTab(sender, runtimeId);
    if (tabId === null) return fail('forbidden-sender', 'only the picker panel saves');
    const record = readPickerSession(await ports.session.get(pickerSessionKey(payload.nonce)));
    if (record?.claimed !== true || record.tabId !== tabId || ports.now() - record.createdAt > PICKER_CLAIMED_TTL_MS) return fail('not-found', 'no open picker session');
    if (payload.hostname !== record.hostname || (await tabHost(ports, tabId)) !== record.hostname) return fail('forbidden-sender', 'host mismatch');
    const key = filterHostKey(record.hostname);
    const store = await read();
    if (store === null) return fail('internal', 'the filter store cannot be read');
    const next = addUserFilter(store, key, payload.selector);
    if (!next.ok) return fail('invalid-payload', next.errors.join('; '));
    await ports.session.remove(pickerSessionKey(payload.nonce));
    await commit(next.value);
    const saved: Saved = { key, hostname: record.hostname, selector: payload.selector, at: ports.now() };
    await ports.session.set(pickerSavedKey(tabId), saved);
    return done;
  });

  /** Who may remove what: a settings page anything; the panel only what it saved in this tab moments ago. */
  const removable = async (payload: { readonly hostname: string; readonly selector: string }, sender: SenderInfo): Promise<{ readonly key: Hostname; readonly tabId: number | null } | null> => {
    const host = parseHostname(payload.hostname);
    if (host === null) return null;
    if (isSettingsPage(sender, runtimeId)) return { key: host, tabId: null };
    const tabId = panelTab(sender, runtimeId);
    const saved = tabId === null ? null : readSaved(await ports.session.get(pickerSavedKey(tabId)));
    const fresh = saved !== null && ports.now() - saved.at <= PICKER_UNDO_MS;
    return fresh && saved.hostname === host && saved.selector === payload.selector ? { key: saved.key, tabId } : null;
  };

  const remove: UserFilterService['remove'] = (payload, sender) => serial(async () => {
    const allowed = await removable(payload, sender);
    if (allowed === null) return fail('forbidden-sender', 'not allowed to remove this filter');
    const before = await read();
    if (before === null) return fail('internal', 'the filter store cannot be read');
    const next = removeUserFilter(before, allowed.key, payload.selector);
    if (allowed.tabId !== null) await ports.session.remove(pickerSavedKey(allowed.tabId));
    if (next !== before) await commit(next);
    return done;
  });

  // Runs on every reconcile (whatever asked for it), so the mirror is re-derived each time (architecture notes §6).
  const reconcileInputs: UserFilterService['reconcileInputs'] = async (sessionRules) => {
    await serial(audit).catch((error: unknown) => { ports.log.warn('uf audit failed', error); });
    const store = (await read()) ?? { v: 1 as const, hosts: {} };
    const live = await Promise.all(sessionRules.filter(isProceedOnceRule).map(async (rule) => {
      const tab = rule.condition.tabIds?.[0];
      return tab !== undefined && (await ports.tabs.get(tab)) !== null ? [rule] : [];
    }));
    return { userFilterHosts: filterHosts(store), sessionRules: live.flat() };
  };

  const replace: UserFilterService['replace'] = (before, next) => serial(async () => {
    const now = await read();
    if (now === null || JSON.stringify(now) !== JSON.stringify(before)) return false;
    await commit(readUserFilters(next));
    return true;
  });

  return { save, remove, current: () => serial(read), replace, audit: () => serial(audit), reconcileInputs };
}
