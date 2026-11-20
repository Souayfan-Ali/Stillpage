/**
 * Worker composition (P1-13): every trigger of architecture notes §5.1 leads to one reconcile; nothing else
 * happens on the worker. No state outside the closures created here, which live for one wake (ADR-012
 * item 7); everything that must outlive a wake is in the vault or `storage.session`.
 */
import type { Ports } from '../platform/ports.js';
import type { WorkerHandlers } from '../platform/events.js';
import { onInstalled } from './firstRun.js';
import { handleMessage } from './messages.js';
import { readPopupInputs } from './popupInputs.js';
import { createReconciler, PAUSE_ALARM, RETRY_ALARM, type Reconciler } from './reconciler.js';
import { createSettingsStore } from './settingsStore.js';
import { createFeatures } from './features.js';
import { startPicker } from './picker.js';
import { hintFromMenuClick } from './pickerHint.js';
import { PICKER_COMMAND } from '../core/manifest.js';
import { USER_FILTER_AUDIT_ALARM } from './userFilters.js';

export interface Worker {
  readonly handlers: WorkerHandlers;
  readonly reconciler: Reconciler;
  /** Reconciles again when the previous worker died during a run. */
  readonly resume: () => Promise<void>;
}

export function createWorker(ports: Ports, runtimeId: string): Worker {
  // One settings store per wake: the reconciler's reads and the commands' writes share its queue.
  const store = createSettingsStore(ports.vault, ports.log);
  // `features` is assigned before any event can run a reconcile (handlers are returned below).
  let requestReconcile: (reason: string) => void = () => undefined;
  const features = createFeatures(ports, runtimeId, async () => (await readPopupInputs(ports, runtimeId)).destinations, () => { requestReconcile('user-filter'); });
  const reconciler = createReconciler(ports, { popups: () => readPopupInputs(ports, runtimeId), user: features.userFilters.reconcileInputs }, store);
  const reconcile = (reason: string): void => {
    // `request` never rejects (guardedRun catches); the catch keeps a logger failure from floating.
    void reconciler.request(reason).catch(() => undefined);
  };
  requestReconcile = reconcile;
  const handlers: WorkerHandlers = {
    installed: (reason) => {
      reconcile(`installed:${reason}`);
      void onInstalled(reason, ports, store);
    },
    startup: () => {
      reconcile('startup');
    },
    permissionsChanged: () => {
      reconcile('permissions');
    },
    alarm: (name) => {
      if (name === PAUSE_ALARM || name === RETRY_ALARM) reconcile(name);
      if (name === USER_FILTER_AUDIT_ALARM) void features.userFilters.audit().catch(() => undefined);
    },
    contextMenu: (tabId, info) => { void startPicker(ports, tabId, 'hide', hintFromMenuClick(info)); },
    command: (name, tabId) => { if (name === PICKER_COMMAND) void startPicker(ports, tabId, 'hide'); },
    message: (message, sender) => handleMessage(message, sender, { runtimeId, ports, store, reconciler, features }),
  };
  return {
    handlers,
    reconciler,
    resume: async () => {
      await reconciler.resumeIfInterrupted();
    },
  };
}
