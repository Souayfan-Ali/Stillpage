/**
 * Picker panel logic (P2-19, cosmetic notes §9, UI notes §5; decisions: design review, P2-19 notes). The panel is an
 * extension page in an iframe the picker places in its closed shadow root. It accepts **one** `hello`
 * from its parent window whose nonce names an unclaimed, young `storage.session` record for this tab
 * (content scripts cannot read that store, so the page cannot know the nonce); invalid hellos are
 * ignored and do not use up the slot. It then talks to the picker only over the transferred port, in
 * indices. "Hide always" is sent to the worker **from here** (`c/saveUserFilter`, hostname from the
 * record, never from the page); the picker script has no way to save.
 */
import { parseCandidates, parseHello, type CandidatesMessage, type CandidateView, type PanelMessage } from '../../core/picker/protocol.js';
import { readPickerSession, usableSession, type PickerSession } from '../../core/picker/session.js';
import { sanitiseSelector } from '../../core/sanitise/selector.js';
import { t } from '../../ui/i18n.js';

export interface ViewModel {
  readonly candidates: readonly CandidateView[];
  readonly index: number;
  readonly hostname: string;
  readonly mode: PickerSession['mode'];
  /** D-81: "Bigger area" / "Smaller area" can act; the picked box is a large part of the page. */
  readonly canWiden: boolean;
  readonly canNarrow: boolean;
  readonly large: boolean;
}

export interface ViewActions {
  /** Slider moved; `preview` is the "hide now" checkbox. */
  readonly select: (index: number, preview: boolean) => void;
  readonly hideOnce: (index: number) => void;
  readonly hideAlways: (index: number) => Promise<void>;
  readonly cancel: () => void;
  /** D-81: no payload; the picker answers with a fresh offer, and nothing acts on an index until it does. */
  readonly widen: () => void;
  readonly narrow: () => void;
}

/** The undo toast after a save (P2-21): Undo, or the toast's own timeout. */
export interface ToastActions {
  readonly undo: () => Promise<void>;
  readonly expire: () => void;
}

export interface PanelDeps {
  readonly window: Window;
  readonly readSession: (nonce: string) => Promise<unknown>;
  readonly claimSession: (nonce: string, session: PickerSession) => Promise<void>;
  readonly currentTabId: () => Promise<number | null>;
  readonly now: () => number;
  readonly send: (envelope: unknown) => Promise<unknown>;
  /** Draws the dialog; returns how to update it in place with a new offer (D-81). */
  readonly render: (model: ViewModel, actions: ViewActions) => (model: ViewModel) => void;
  readonly showError: (text: string) => void;
  readonly showToast: (actions: ToastActions) => void;
}

const SAVE_FAILED = t('picker_save_failed');
const UNDO_FAILED = t('picker_undo_failed');

async function verify(deps: PanelDeps, nonce: string): Promise<PickerSession | null> {
  const [raw, tabId] = await Promise.all([deps.readSession(nonce), deps.currentTabId()]);
  const session = readPickerSession(raw);
  return session !== null && tabId !== null && usableSession(session, tabId, deps.now()) ? session : null;
}

const isOk = (r: unknown): boolean => typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === true;
const requestId = (): string => `pk-${Date.now().toString(36)}`;

/** The offer the indices refer to; `waiting` from a widen / narrow until the picker's answer replaces it. */
interface Offer {
  candidates: readonly CandidateView[];
  waiting: boolean;
}

function actionsFor(deps: PanelDeps, port: MessagePort, nonce: string, session: PickerSession, offer: Offer): ViewActions {
  const inRange = (i: number): boolean => !offer.waiting && Number.isInteger(i) && i >= 0 && i < offer.candidates.length;
  const post = (m: PanelMessage): void => { port.postMessage(m); };
  const step = (type: 'widen' | 'narrow'): void => {
    if (offer.waiting) return;
    offer.waiting = true;
    post({ type });
  };
  return {
    select: (i, preview) => { if (inRange(i)) post({ type: 'preview', index: preview ? i : null }); },
    hideOnce: (i) => { if (inRange(i)) post({ type: 'zap', index: i }); },
    cancel: () => { post({ type: 'cancel' }); },
    widen: () => { step('widen'); },
    narrow: () => { step('narrow'); },
    hideAlways: async (i) => {
      const selector = inRange(i) ? sanitiseSelector(offer.candidates[i]?.selector) : null;
      if (selector === null) return;
      const payload = { hostname: session.hostname, selector, nonce };
      const answer = await deps.send({ v: 1, type: 'c/saveUserFilter', id: requestId(), payload }).catch(() => null);
      if (!isOk(answer)) {
        deps.showError(SAVE_FAILED);
        return;
      }
      post({ type: 'saved', index: i });
      deps.showToast({
        undo: async () => {
          const removal = { hostname: session.hostname, selector };
          const undone = await deps.send({ v: 1, type: 'c/removeUserFilter', id: requestId(), payload: removal }).catch(() => null);
          if (isOk(undone)) post({ type: 'undo', index: i });
          else deps.showError(UNDO_FAILED);
        },
        expire: () => { post({ type: 'close' }); },
      });
    },
  };
}

const modelOf = (m: CandidatesMessage, session: PickerSession): ViewModel => ({
  candidates: m.candidates, index: m.initial, hostname: session.hostname, mode: session.mode,
  canWiden: m.canWiden === true, canNarrow: m.canNarrow === true, large: m.large === true,
});

function connect(deps: PanelDeps, port: MessagePort, nonce: string, session: PickerSession): void {
  const offer: Offer = { candidates: [], waiting: false };
  const actions = actionsFor(deps, port, nonce, session, offer);
  let refresh: ((model: ViewModel) => void) | null = null;
  port.onmessage = (e: MessageEvent) => {
    const message = parseCandidates(e.data);
    if (message === null) return;
    if (refresh === null) {
      offer.candidates = message.candidates;
      refresh = deps.render(modelOf(message, session), actions);
      port.postMessage({ type: 'ready' } satisfies PanelMessage);
      return;
    }
    // D-81: only the answer to a widen / narrow replaces the offer, all at once; anything else is dropped.
    if (!offer.waiting) return;
    offer.candidates = message.candidates;
    offer.waiting = false;
    refresh(modelOf(message, session));
  };
}

/** Waits for the picker's `hello`; returns a function that stops waiting. */
export function startPanel(deps: PanelDeps): () => void {
  let state: 'waiting' | 'checking' | 'ready' = 'waiting';
  const onMessage = (event: Event): void => {
    if (state !== 'waiting' || !(event instanceof MessageEvent) || event.source !== deps.window.parent) return;
    const nonce = parseHello(event.data);
    const port = event.ports.length === 1 ? event.ports[0] : undefined;
    if (nonce === null || port === undefined) return;
    state = 'checking';
    const refuse = (): void => {
      state = 'waiting';
      port.close();
    };
    void verify(deps, nonce).catch(() => null).then(async (session) => {
      if (session === null) {
        refuse();
        return;
      }
      try {
        await deps.claimSession(nonce, session);
      } catch {
        refuse();
        return;
      }
      state = 'ready';
      deps.window.removeEventListener('message', onMessage);
      connect(deps, port, nonce, session);
    });
  };
  deps.window.addEventListener('message', onMessage);
  return () => { deps.window.removeEventListener('message', onMessage); };
}
