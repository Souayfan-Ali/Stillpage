// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { openPanel, PANEL_READY_TIMEOUT_MS } from '../../../../src/content/picker/channel.js';
import type { CandidatesMessage, PanelMessage } from '../../../../src/core/picker/protocol.js';

const CANDIDATES: CandidatesMessage = { type: 'candidates', candidates: [{ selector: '#a', count: 1 }, { selector: '.a', count: 2 }], initial: 0 };
const URL_ = 'chrome-extension://abcdefgh/picker-panel.html';

const failed: number[] = [];
const timers: (() => void)[] = [];
const cancelled: number[] = [];
const delays: number[] = [];

function setup() {
  failed.length = 0;
  timers.length = 0;
  cancelled.length = 0;
  delays.length = 0;
  const received: PanelMessage[] = [];
  const handle = openPanel({
    document, panelUrl: URL_, panelOrigin: 'chrome-extension://abcdefgh', nonce: 'abcdefghijklmnop1234', title: 'The panel title', candidates: CANDIDATES,
    mount: (node) => { document.body.append(node); }, onMessage: (m) => { received.push(m); },
    onFail: () => { failed.push(1); }, setTimer: (run, ms) => { timers.push(run); delays.push(ms); return () => { cancelled.push(1); }; },
  });
  const iframe = document.querySelector('iframe');
  const frameWindow = iframe?.contentWindow ?? null;
  if (iframe === null || frameWindow === null) throw new Error('no iframe');
  return { handle, iframe, frameWindow, received };
}

function only<T>(x: T | undefined): T {
  if (x === undefined) throw new Error('missing');
  return x;
}

const nextMessage = (port: MessagePort): Promise<unknown> => new Promise((resolve) => {
  port.onmessage = (e: MessageEvent) => { resolve(e.data); };
});

describe('openPanel', () => {
  test('posts one hello with the nonce to the extension origin only, with one port; then candidates over the port', async () => {
    const { iframe, frameWindow, handle } = setup();
    expect(iframe.getAttribute('src')).toBe(URL_);
    expect(iframe.title).toBe('The panel title');
    const post = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
    iframe.dispatchEvent(new Event('load'));
    iframe.dispatchEvent(new Event('load'));
    expect(post).toHaveBeenCalledTimes(1);
    const [data, origin, transfer] = post.mock.calls[0] as unknown as [unknown, string, MessagePort[]];
    expect(data).toEqual({ type: 'hello', nonce: 'abcdefghijklmnop1234' });
    expect(origin).toBe('chrome-extension://abcdefgh');
    expect(transfer).toHaveLength(1);
    const port = only(transfer[0]);
    expect(await nextMessage(port)).toEqual(CANDIDATES);
    handle.close();
    port.close();
  });

  test('panel messages are parsed as bounded indices; anything else is dropped', async () => {
    const { iframe, frameWindow, received, handle } = setup();
    const post = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
    iframe.dispatchEvent(new Event('load'));
    const port = only((post.mock.calls[0] as unknown as [unknown, string, MessagePort[]])[2][0]);
    port.postMessage({ type: 'save', selector: 'body' });
    port.postMessage({ type: 'zap', index: 9 });
    port.postMessage({ type: 'preview', index: 1 });
    await vi.waitFor(() => { expect(received).toEqual([{ type: 'preview', index: 1 }]); });
    handle.close();
    expect(document.querySelector('iframe')).toBeNull();
    port.close();
  });

  test('D-81: offer() sends the new candidates; later indices are bounded by the new offer', async () => {
    const { iframe, frameWindow, received, handle } = setup();
    const post = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
    iframe.dispatchEvent(new Event('load'));
    const port = only((post.mock.calls[0] as unknown as [unknown, string, MessagePort[]])[2][0]);
    await nextMessage(port);
    const wider: CandidatesMessage = { type: 'candidates', candidates: [{ selector: '#b', count: 1 }], initial: 0, canWiden: false, canNarrow: true, large: false };
    const next = nextMessage(port);
    handle.offer(wider);
    expect(await next).toEqual(wider);
    port.postMessage({ type: 'zap', index: 1 });
    port.postMessage({ type: 'widen' });
    port.postMessage({ type: 'zap', index: 0 });
    await vi.waitFor(() => { expect(received).toEqual([{ type: 'widen' }, { type: 'zap', index: 0 }]); });
    handle.close();
    port.close();
  });

  test('ready cancels the timeout; no ready in time fails the run', async () => {
    const { iframe, frameWindow, handle } = setup();
    const post = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => undefined);
    iframe.dispatchEvent(new Event('load'));
    const port = only((post.mock.calls[0] as unknown as [unknown, string, MessagePort[]])[2][0]);
    port.postMessage({ type: 'ready' });
    expect(delays).toEqual([PANEL_READY_TIMEOUT_MS]);
    await vi.waitFor(() => { expect(cancelled).toHaveLength(1); });
    timers[0]?.();
    expect(failed).toHaveLength(1);
    handle.close();
    port.close();
  });

  test('D-109: the frame opens 520px high, capped at the viewport less 32px; toast() shrinks it to 72px', () => {
    const { iframe, handle } = setup();
    expect(iframe.style.getPropertyValue('height')).toBe('520px');
    expect(iframe.style.getPropertyPriority('height')).toBe('important');
    expect(iframe.style.getPropertyValue('max-height')).toBe('calc(100vh - 32px)');
    expect(iframe.style.getPropertyPriority('max-height')).toBe('important');
    handle.toast();
    expect(iframe.style.getPropertyValue('height')).toBe('72px');
    handle.close();
  });

  test('close before load removes the frame', () => {
    const { handle } = setup();
    handle.close();
    expect(document.querySelector('iframe')).toBeNull();
  });
});
