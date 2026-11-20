/**
 * The picker session record (P2-19; design review): the worker, on `c/startPicker`, mints a nonce and writes
 * `storage.session['picker:<nonce>']`. Extension pages can read it, content scripts cannot (default
 * access level), so the nonce a `hello` carries proves the sender got it from the worker. The panel
 * accepts a record only for its own tab, unclaimed and young, then marks it claimed; the save handler
 * (P2-20) deletes it. The hostname to save under comes from here, never from the page.
 */
import { parseHostname } from '../hostname/validate.js';
import type { Hostname } from '../ids.js';

/** An unclaimed picker session older than this is refused (design review: 2 min). */
export const PICKER_SESSION_TTL_MS = 2 * 60_000;
/** A claimed session (panel open) may save until this long after it was created. */
export const PICKER_CLAIMED_TTL_MS = 15 * 60_000;
/** Index of the open session per tab (one per tab; a new start replaces the old one). */
export const PICKER_TABS_KEY = 'picker:tabs';
/** After a save: what "Undo" may remove, for this long (P2-21). */
export const PICKER_UNDO_MS = 30_000;
export const pickerSavedKey = (tabId: number): string => `picker-saved:${String(tabId)}`;

export const pickerSessionKey = (nonce: string): string => `picker:${nonce}`;

export interface PickerSession {
  readonly tabId: number;
  readonly hostname: Hostname;
  readonly mode: 'zap' | 'hide';
  readonly createdAt: number;
  readonly claimed: boolean;
}

const KEYS = ['claimed', 'createdAt', 'hostname', 'mode', 'tabId'].join();

/** The record, or `null` when it is missing or malformed. */
export function readPickerSession(raw: unknown): PickerSession | null {
  if (typeof raw !== 'object' || raw === null || Object.keys(raw).sort().join() !== KEYS) return null;
  const r = raw as Readonly<Record<string, unknown>>;
  const hostname = parseHostname(r['hostname']);
  const { tabId, mode, createdAt, claimed } = r;
  if (hostname === null || hostname !== r['hostname'] || !Number.isInteger(tabId) || (tabId as number) < 0) return null;
  if ((mode !== 'zap' && mode !== 'hide') || typeof createdAt !== 'number' || typeof claimed !== 'boolean') return null;
  return { tabId: tabId as number, hostname, mode, createdAt, claimed };
}

/** True when a panel in `tabId` may use the record at `now`. */
export function usableSession(s: PickerSession, tabId: number, now: number): boolean {
  return s.tabId === tabId && !s.claimed && now >= s.createdAt && now - s.createdAt <= PICKER_SESSION_TTL_MS;
}
