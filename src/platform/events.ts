/**
 * The worker's listeners (architecture notes §2, ADR-012 item 3). This file holds every `addListener` call in
 * shipped code, and a unit test checks the list: `runtime.onInstalled`, `runtime.onStartup`,
 * `runtime.onMessage`, `permissions.onAdded`, `permissions.onRemoved`, `alarms.onAlarm`. Never a
 * `webRequest`, `webNavigation` or `tabs` listener, never a port. They are added synchronously at
 * the worker's top level so Chrome can deliver the event that woke it.
 */
import { browser } from 'wxt/browser';
import type { SenderInfo } from '../core/messaging/sender.js';
import { t } from '../ui/i18n.js';

/** The context menu entry of the element hider. */
const PICKER_MENU_ID = 'hide-element';

export interface WorkerHandlers {
  readonly installed: (reason: string) => void;
  readonly startup: () => void;
  readonly permissionsChanged: () => void;
  readonly alarm: (name: string) => void;
  /** "Hide this…" chosen in a tab (P2-21); `info` is unvalidated (`background/pickerHint.ts`, P3-17). */
  readonly contextMenu?: (tabId: number, info: unknown) => void;
  /** A manifest command (keyboard shortcut) in the active tab (P2-21). */
  readonly command?: (name: string, tabId: number) => void;
  /** Resolves the response; the listener keeps the channel open until then. */
  readonly message: (message: unknown, sender: SenderInfo) => Promise<unknown>;
}

export function addWorkerListeners(handlers: WorkerHandlers): void {
  browser.runtime.onInstalled.addListener((details) => {
    // The context menu entry is made once per install or update; Chrome keeps it (P2-21).
    browser.contextMenus.removeAll(() => {
      browser.contextMenus.create({ id: PICKER_MENU_ID, title: t('menu_hide_element'), contexts: ['page', 'frame', 'selection', 'link', 'image', 'video'], documentUrlPatterns: ['http://*/*', 'https://*/*'] });
    });
    handlers.installed(details.reason);
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === PICKER_MENU_ID && tab?.id !== undefined) handlers.contextMenu?.(tab.id, info);
  });
  browser.commands.onCommand.addListener((name, tab) => {
    if (tab?.id !== undefined) handlers.command?.(name, tab.id);
  });
  browser.runtime.onStartup.addListener(() => {
    handlers.startup();
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const reply = (response: unknown): void => {
      try {
        sendResponse(response);
      } catch {
        // The sender went away (page closed); nothing to answer.
      }
    };
    // `message` never rejects (`handleMessage` logs a throwing handler); the catch is the last guard.
    void handlers
      .message(message, sender)
      .catch(() => ({ ok: false, error: { code: 'internal', message: 'internal error' } }))
      .then(reply);
    return true;
  });
  browser.permissions.onAdded.addListener(() => {
    handlers.permissionsChanged();
  });
  browser.permissions.onRemoved.addListener(() => {
    handlers.permissionsChanged();
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    handlers.alarm(alarm.name);
  });
}
