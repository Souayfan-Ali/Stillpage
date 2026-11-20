/**
 * Starting the element picker (P2-21, cosmetic notes §9; design review; security review of P2-18/P2-19). Entry points:
 * the toolbar panel (`c/startPicker`, checked against the active tab), the context menu and the keyboard
 * shortcut (called directly with the event's tab). One session per tab: a 128-bit nonce in
 * `storage.session['picker:<nonce>']` (written before the script runs), `picker.js` injected into the
 * top frame (ISOLATED), then `x/pickerStart`. Stale sessions are pruned here, lazily (no tab listeners).
 */
import { parseHostname } from '../core/hostname/validate.js';
import type { MessageError, Response } from '../core/messaging/parse.js';
import type { SenderInfo } from '../core/messaging/sender.js';
import type { PickHint } from '../core/picker/hint.js';
import { PICKER_CLAIMED_TTL_MS, PICKER_SESSION_TTL_MS, PICKER_TABS_KEY, pickerSessionKey, readPickerSession } from '../core/picker/session.js';
import type { Ports } from '../platform/ports.js';
import { ownPagePath } from './senders.js';

type Started = Response<null>;
const fail = (code: MessageError['code'], message: string): Started => ({ ok: false, error: { code, message } });
const NONCE_BYTES = 16;

/** 128 random bits, base64url (22 characters; the envelope's nonce pattern). */
export function mintNonce(fill: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => { crypto.getRandomValues(b); }): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  fill(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Index = Readonly<Record<string, string>>;
const readIndex = (raw: unknown): Index =>
  typeof raw === 'object' && raw !== null ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};

/** Drops this tab's old session and every expired or dead-tab one; returns the remaining index. */
async function prune(ports: Ports, tabId: number): Promise<Index> {
  const index = readIndex(await ports.session.get(PICKER_TABS_KEY));
  const kept = await Promise.all(Object.entries(index).map(async ([tab, nonce]) => {
    const record = readPickerSession(await ports.session.get(pickerSessionKey(nonce)));
    const ttl = record?.claimed === true ? PICKER_CLAIMED_TTL_MS : PICKER_SESSION_TTL_MS;
    const alive = record !== null && Number(tab) !== tabId && ports.now() - record.createdAt <= ttl && (await ports.tabs.get(Number(tab))) !== null;
    if (!alive) await ports.session.remove(pickerSessionKey(nonce));
    return alive ? [[tab, nonce] as const] : [];
  }));
  return Object.fromEntries(kept.flat());
}

/** One start at a time per worker (the tab index is read, changed and written; review LOW-4). */
const queues = new WeakMap<Ports, Promise<unknown>>();

/** Starts the picker in `tabId` (an http(s) tab), with the right-clicked element when known (P3-17). Serialised. */
export function startPicker(ports: Ports, tabId: number, mode: 'zap' | 'hide', hint: PickHint | null = null): Promise<Started> {
  const run = (queues.get(ports) ?? Promise.resolve()).then(() => startOnce(ports, tabId, mode, hint));
  queues.set(ports, run.catch(() => undefined));
  return run;
}

async function startOnce(ports: Ports, tabId: number, mode: 'zap' | 'hide', hint: PickHint | null): Promise<Started> {
  const user = ports.user;
  if (user === undefined) return fail('internal', 'no picker support');
  try {
    const tab = await ports.tabs.get(tabId);
    const url = tab?.url !== undefined && tab.url !== null && URL.canParse(tab.url) ? new URL(tab.url) : null;
    const hostname = url !== null && (url.protocol === 'https:' || url.protocol === 'http:') ? parseHostname(url.hostname) : null;
    if (hostname === null) return fail('not-found', 'the picker runs on web pages only');
    const index = await prune(ports, tabId);
    const nonce = mintNonce();
    await ports.session.set(pickerSessionKey(nonce), { tabId, hostname, mode, createdAt: ports.now(), claimed: false });
    await ports.session.set(PICKER_TABS_KEY, { ...index, [String(tabId)]: nonce });
    await user.injectPicker(tabId);
    await user.sendToTopFrame(tabId, { type: 'x/pickerStart', nonce, mode, ...(hint !== null && { hint }) });
    return { ok: true, data: null };
  } catch (error) {
    ports.log.warn('picker not started', error);
    return fail('internal', 'could not start the picker on this page');
  }
}

/**
 * `c/startPicker` from the toolbar panel: top-level page, no tab, and the tab named must be the active
 * tab of a browser window (the panel's own window is not knowable from the sender).
 */
export async function startPickerMessage(ports: Ports, runtimeId: string, payload: { readonly tabId: number; readonly mode: 'zap' | 'hide' }, sender: SenderInfo): Promise<Started> {
  // `popup.html` is not web-accessible, so no page can frame or open it; it may run in a tab or window
  // (E2E, "open in a tab") but must be the top-level document.
  const topLevel = sender.frameId === undefined || sender.frameId === 0;
  if (ownPagePath(sender, runtimeId) !== '/popup.html' || !topLevel) return fail('forbidden-sender', 'only the toolbar panel starts the picker');
  const active = (await ports.user?.activeTabIds()) ?? [];
  if (!active.includes(payload.tabId)) return fail('forbidden-sender', 'not the active tab');
  return startPicker(ports, payload.tabId, payload.mode);
}
