/**
 * The picker's side of the panel channel (P2-19, cosmetic notes §9; design review). The panel iframe lives in the
 * overlay's closed shadow root. On its `load`, a `MessageChannel` is made and the panel receives one
 * `hello` with the nonce and one port, posted to the extension origin only (never `'*'`). Everything
 * else goes over the port; what comes back is parsed as indices into the candidates sent.
 */
import { parsePanelMessage, type CandidatesMessage, type PanelMessage } from '../../core/picker/protocol.js';

export interface PanelEnv {
  readonly document: Document;
  /** `runtime.getURL('picker-panel.html')` (the `use_dynamic_url` address). */
  readonly panelUrl: string;
  /**
   * The panel document's origin, `chrome-extension://<runtime.id>`: the frame runs at the real id even
   * when loaded through the dynamic address, so the `hello` targets this (measured in P2-19's E2E).
   */
  readonly panelOrigin: string;
  readonly nonce: string;
  /** The frame's accessible name, from `_locales` (P2-40; read by the entry script). */
  readonly title: string;
  readonly candidates: CandidatesMessage;
  readonly mount: (node: Element) => void;
  readonly onMessage: (message: PanelMessage) => void;
  /** The panel did not report `ready` in time (frame blocked by the page, navigated, or refused the hello). */
  readonly onFail: () => void;
  readonly setTimer: (run: () => void, ms: number) => () => void;
}

/** How long the picker waits for the panel's `ready` (security review LOW-5). */
export const PANEL_READY_TIMEOUT_MS = 5_000;

export interface PanelHandle {
  readonly close: () => void;
  /** Shrinks the frame to the undo toast (P2-21). */
  readonly toast: () => void;
  /** Replaces the offer (D-81: after "Bigger / Smaller area"); later indices are read against it. */
  readonly offer: (candidates: CandidatesMessage) => void;
}

const TOAST_STYLES: Readonly<Record<string, string>> = { width: '320px', height: '72px' };

const FRAME_STYLES: Readonly<Record<string, string>> = {
  position: 'fixed', right: '16px', bottom: '16px', width: '360px', height: '520px', 'max-height': 'calc(100vh - 32px)',
  border: '0', 'border-radius': '8px', 'box-shadow': '0 8px 32px rgba(0,0,0,0.35)', 'pointer-events': 'auto', 'color-scheme': 'normal', // i18n-exempt: CSS
};

/** Opens the panel; the port is the only channel after the one `hello`. */
export function openPanel(env: PanelEnv): PanelHandle {
  const iframe = env.document.createElement('iframe');
  for (const [name, value] of Object.entries(FRAME_STYLES)) iframe.style.setProperty(name, value, 'important');
  iframe.setAttribute('title', env.title);
  iframe.src = env.panelUrl;
  let port: MessagePort | null = null;
  let offered = env.candidates;
  const cancelTimer = env.setTimer(env.onFail, PANEL_READY_TIMEOUT_MS);
  iframe.addEventListener('load', () => {
    const target = iframe.contentWindow;
    if (target === null || port !== null) return;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (e: MessageEvent) => {
      const message = parsePanelMessage(e.data, offered.candidates.length);
      if (message?.type === 'ready') cancelTimer();
      else if (message !== null) env.onMessage(message);
    };
    target.postMessage({ type: 'hello', nonce: env.nonce }, env.panelOrigin, [channel.port2]);
    port.postMessage(offered);
    iframe.focus();
  }, { once: true });
  env.mount(iframe);
  return {
    close: () => {
      cancelTimer();
      port?.close();
      iframe.remove();
    },
    toast: () => {
      for (const [name, value] of Object.entries(TOAST_STYLES)) iframe.style.setProperty(name, value, 'important');
    },
    offer: (candidates) => {
      offered = candidates;
      port?.postMessage(candidates);
    },
  };
}
