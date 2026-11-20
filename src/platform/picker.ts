/**
 * The `chrome.*` calls of the picker (P2-18/P2-19), kept behind the platform boundary: the content
 * script's runtime id, the panel's address and origin, its start messages; the panel page's session
 * record, tab and worker channel. New file; the logic lives in `content/picker` and `features/picker-panel`.
 */
import { browser } from 'wxt/browser';
import { pickerSessionKey, type PickerSession } from '../core/picker/session.js';
import type { PickerLabels } from '../content/picker/controller.js';
import { t } from '../ui/i18n.js';

export interface PickerRuntime {
  readonly id: string;
  /** `runtime.getURL('picker-panel.html')` (the `use_dynamic_url` address). */
  readonly panelUrl: string;
  /** The panel document's origin: it runs at the real id (P2-19 E2E). */
  readonly panelOrigin: string;
  /** The picker's words in the page, from `_locales` (P2-40). */
  readonly labels: PickerLabels;
  readonly onMessage: (listener: (message: unknown, sender: { readonly id?: string; readonly tab?: unknown }) => void) => void;
}

export function pickerRuntime(): PickerRuntime {
  return {
    id: browser.runtime.id,
    panelUrl: browser.runtime.getURL('/picker-panel.html'),
    panelOrigin: `chrome-extension://${browser.runtime.id}`,
    labels: { overlay: t('picker_overlay_label'), panel: t('picker_title'), hint: t('picker_hint') },
    onMessage: (listener) => { browser.runtime.onMessage.addListener((message: unknown, sender) => { listener(message, sender); }); },
  };
}

export interface PanelPort {
  readonly readSession: (nonce: string) => Promise<unknown>;
  readonly claimSession: (nonce: string, session: PickerSession) => Promise<void>;
  readonly currentTabId: () => Promise<number | null>;
  readonly send: (envelope: unknown) => Promise<unknown>;
}

export function panelPort(): PanelPort {
  return {
    readSession: async (nonce) => (await browser.storage.session.get(pickerSessionKey(nonce)))[pickerSessionKey(nonce)],
    claimSession: (nonce, session) => browser.storage.session.set({ [pickerSessionKey(nonce)]: { ...session, claimed: true } }),
    currentTabId: async () => (await browser.tabs.getCurrent())?.id ?? null,
    send: (envelope) => browser.runtime.sendMessage(envelope),
  };
}
