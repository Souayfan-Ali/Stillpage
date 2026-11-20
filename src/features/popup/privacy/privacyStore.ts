/**
 * The privacy panel's data (P2-12): one `q/matchedRules` per panel open and tab (S-06: at most once
 * per open), and "Copy summary". The worker caches per page for 30 s (P2-11).
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import type { MatchedRules } from '../../../core/messaging/matched.js';
import type { PopupLog } from '../../../core/popup/log.js';
import type { Client } from '../client.js';
import { PRIVACY_STRINGS } from './strings.js';
import { summaryText } from './summary.js';

export type MatchedView = { readonly kind: 'idle' } | { readonly kind: 'loading' } | { readonly kind: 'failed' } | MatchedRules;

export interface PrivacyStore {
  readonly matched: ReadonlySignal<MatchedView>;
  /** Result of "Copy summary", for a `role="status"` line. */
  readonly copyStatus: ReadonlySignal<string>;
  /** The page's pop-up log (P2-62); `null` while unknown or when the page has no sentinel. */
  readonly popups: ReadonlySignal<PopupLog | null>;
  load(tabId: number): Promise<void>;
  copy(host: string | null): Promise<void>;
}

export interface PrivacyDeps {
  readonly client: Pick<Client, 'matchedRules'>;
  /** Writes text to the clipboard (inside the click). */
  readonly copyText: (text: string) => Promise<void>;
  /** The page's validated pop-up log, or `null` (no sentinel). */
  readonly popupLog?: (tabId: number) => Promise<PopupLog | null>;
}

export function createPrivacyStore(deps: PrivacyDeps): PrivacyStore {
  const matched = signal<MatchedView>({ kind: 'idle' });
  const copyStatus = signal('');
  const popups = signal<PopupLog | null>(null);
  let loadedFor: number | null = null;

  const load = async (tabId: number): Promise<void> => {
    if (loadedFor === tabId) return;
    loadedFor = tabId;
    matched.value = { kind: 'loading' };
    // No answer is no log (the page has no sentinel or went away), the same as `null`.
    const showLog = (log: PopupLog | null): void => {
      if (loadedFor === tabId) popups.value = log;
    };
    void deps.popupLog?.(tabId).then(showLog, () => {
      showLog(null);
    });
    const result = await deps.client.matchedRules(tabId);
    if (loadedFor === tabId) matched.value = result.ok ? result.data : { kind: 'failed' };
  };

  const copy = async (host: string | null): Promise<void> => {
    const current = matched.value;
    if (current.kind !== 'counts') return;
    const done = await deps.copyText(summaryText(host, current)).then(
      () => true,
      () => false,
    );
    copyStatus.value = done ? PRIVACY_STRINGS.copied : PRIVACY_STRINGS.copyFailed;
  };

  return { matched, copyStatus, popups, load, copy };
}
