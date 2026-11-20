/**
 * Panel state and actions (P1-40, P1-41). Signals hold what is drawn; every change goes to the worker
 * as a command through the client (P1-12 envelope) and is then re-read, so the worker stays the only
 * writer of settings. Site access is asked for from the page inside the click (architecture notes §8).
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import type { PauseChoice } from '../../core/state/site.js';
import type { Level } from '../../core/state/types.js';
import type { Client, ClientResult } from './client.js';
import type { HeaderAction } from './header.js';
import { STRINGS } from './strings.js';
import type { TabState } from '../../core/messaging/tabState.js';

export type ChoosableLevel = Exclude<Level, 'off'>;

export type View =
  { readonly kind: 'loading' } | { readonly kind: 'unavailable' } | { readonly kind: 'ready'; readonly tabId: number; readonly state: TabState };

export interface PageAccess {
  activeTabId(): Promise<number | null>;
  /** Must be called synchronously inside the click handler (user gesture). */
  requestOrigins(origins: readonly string[]): Promise<boolean>;
  /** Reloads the panel's tab (`tabs.reload`; needs no `tabs` permission). */
  reloadTab(tabId: number): Promise<void>;
}

export interface PopupStore {
  readonly view: ReadonlySignal<View>;
  /** Result of the last action, for the `role="status"` line. */
  readonly status: ReadonlySignal<string>;
  /** A change was saved: the panel offers "Reload page" (it never reloads by itself, UI notes §3). */
  readonly reloadOffered: ReadonlySignal<boolean>;
  load(): Promise<void>;
  chooseLevel(level: ChoosableLevel): Promise<void>;
  act(action: HeaderAction): Promise<void>;
  /** The pause menu: 30 or 60 minutes, or `null` for Off until turned back on. */
  pause(choice: PauseChoice): Promise<void>;
  reload(): Promise<void>;
  /** "Hide something" (P2-21): starts the element picker in this tab; `true` when it started. */
  hideSomething(): Promise<boolean>;
}

export type { PauseChoice };

export interface StoreDeps {
  readonly client: Client;
  readonly page: PageAccess;
  /** `?tabId=` of the panel URL when given (performance notes §3), else the active tab is used. */
  readonly tabIdFromUrl: number | null;
}

const ALL_SITES = '<all_urls>';

function failureText(result: ClientResult<unknown>): string {
  if (result.ok) return STRINGS.saved;
  return result.error.code === 'not-implemented' ? STRINGS.notAvailableYet : STRINGS.saveFailed;
}

/** Keeps the panel's mutable bookkeeping in one place (not shared, one per panel). */
interface Pending {
  wantedLevel: ChoosableLevel | null;
  sending: boolean;
  busy: boolean;
  loadToken: number;
}

export function createPopupStore(deps: StoreDeps): PopupStore {
  const view = signal<View>({ kind: 'loading' });
  const status = signal('');
  const reloadOffered = signal(false);
  const pending: Pending = { wantedLevel: null, sending: false, busy: false, loadToken: 0 };
  const ready = (): Extract<View, { kind: 'ready' }> | null => (view.value.kind === 'ready' ? view.value : null);
  const choicePending = (): boolean => pending.sending || pending.wantedLevel !== null;

  /**
   * Reads the tab state. Only the newest read is applied; a read that would overwrite a level choice
   * still being sent is dropped (`force` is the re-read after the send loop). A failed read keeps a
   * view the panel already has and says so, instead of wiping it.
   */
  const refresh = async (force: boolean): Promise<void> => {
    const token = ++pending.loadToken;
    const tabId = deps.tabIdFromUrl ?? (await deps.page.activeTabId().catch(() => null));
    const result = tabId === null ? null : await deps.client.tabState(tabId);
    if (token !== pending.loadToken || (!force && choicePending())) return;
    if (tabId !== null && result?.ok === true) {
      view.value = { kind: 'ready', tabId, state: result.data };
    } else if (ready() === null) {
      view.value = { kind: 'unavailable' };
    } else {
      status.value = STRINGS.unavailable;
    }
  };

  const takeWanted = (): ChoosableLevel | null => {
    const level = pending.wantedLevel;
    pending.wantedLevel = null;
    return level;
  };

  /** Sends only the latest wanted level (arrowing across the radios), then re-reads the real state once. */
  const sendLevels = async (): Promise<void> => {
    if (pending.sending) return;
    pending.sending = true;
    let last: ClientResult<null> | null = null;
    try {
      for (let level = takeWanted(); level !== null; level = takeWanted()) {
        const host = ready()?.state.host ?? null;
        if (host === null) break;
        last = await deps.client.command('c/setSiteLevel', { hostname: host, level });
      }
    } finally {
      pending.sending = false;
    }
    status.value = last === null ? STRINGS.saveFailed : failureText(last);
    reloadOffered.value = last?.ok === true;
    await refresh(true);
  };

  const chooseLevel = async (level: ChoosableLevel): Promise<void> => {
    const current = ready();
    const host = current?.state.host ?? null;
    if (current === null || host === null) return;
    view.value = { ...current, state: { ...current.state, level, setOn: host } };
    status.value = STRINGS.saving;
    pending.wantedLevel = level;
    await sendLevels();
  };

  /** Calls Chrome synchronously (still inside the click); a throw or a rejection counts as "not allowed". */
  const requestAccess = async (origins: readonly string[]): Promise<void> => {
    let asked: Promise<boolean>;
    try {
      asked = deps.page.requestOrigins(origins);
    } catch {
      asked = Promise.resolve(false);
    }
    const granted = await asked.catch(() => false);
    status.value = granted ? STRINGS.accessGranted : STRINGS.accessDenied;
    if (granted) await refresh(false);
  };

  /** Sends one command, says how it went, offers a reload when asked to, and re-reads the state. */
  const send = async (command: () => Promise<ClientResult<null>>, offerReload: boolean): Promise<void> => {
    status.value = STRINGS.saving;
    const result = await command();
    status.value = result.ok && !offerReload ? STRINGS.done : failureText(result);
    reloadOffered.value = result.ok && offerReload;
    if (result.ok) await refresh(false);
  };

  const turnOn = (state: TabState): Promise<void> => {
    const hostname = state.setOn ?? state.host;
    if (hostname === null) return Promise.resolve();
    return send(() => deps.client.command('c/setSiteLevel', { hostname, level: 'inherit' }), true);
  };

  const run = (action: HeaderAction, state: TabState): Promise<void> => {
    if (action === 'allowAll') return requestAccess([ALL_SITES]);
    if (action === 'allowSite') return state.host === null ? Promise.resolve() : requestAccess([`*://${state.host}/*`]);
    if (action === 'turnOn' || action === 'resume') return turnOn(state);
    if (action === 'dismiss') return send(() => deps.client.command('c/dismissNotice', {}), false);
    status.value = STRINGS.notAvailableYet;
    return Promise.resolve();
  };

  /** One action at a time; `task` gets the ready view. */
  const exclusive = async (task: (current: Extract<View, { kind: 'ready' }>) => Promise<void>): Promise<void> => {
    const current = ready();
    if (current === null || pending.busy || choicePending()) return;
    pending.busy = true;
    try {
      await task(current);
    } finally {
      pending.busy = false;
    }
  };

  const pause = (choice: PauseChoice): Promise<void> =>
    exclusive(async ({ state }) => {
      if (state.host === null) return;
      const hostname = state.host;
      await send(() => deps.client.command('c/pauseSite', { hostname, minutes: choice }), true);
    });

  const reload = (): Promise<void> =>
    exclusive(async ({ tabId }) => {
      reloadOffered.value = false;
      const done = await deps.page.reloadTab(tabId).then(
        () => true,
        () => false,
      );
      status.value = done ? STRINGS.reloaded : STRINGS.reloadFailed;
    });

  const hideSomething = async (): Promise<boolean> => {
    const current = ready();
    if (current === null) return false;
    const result = await deps.client.command('c/startPicker', { tabId: current.tabId, mode: 'hide' });
    status.value = result.ok ? '' : STRINGS.pickerUnavailable;
    return result.ok;
  };

  return { view, status, reloadOffered, load: () => refresh(false), chooseLevel, act: (action) => exclusive(({ state }) => run(action, state)), pause, reload, hideSomething };
}
