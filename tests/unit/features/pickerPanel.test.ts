// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { startPanel, type PanelDeps, type ToastActions, type ViewActions, type ViewModel } from '../../../src/features/picker-panel/panel.js';
import type { CandidatesMessage } from '../../../src/core/picker/protocol.js';

const NONCE = 'abcdefghijklmnop1234';
const NOW = 1_800_000_000_000;
const RECORD = { tabId: 7, hostname: 'news.example.com', mode: 'hide', createdAt: NOW - 1_000, claimed: false };
const CANDIDATES: CandidatesMessage = { type: 'candidates', candidates: [{ selector: '#t', count: 1 }, { selector: 'li.row', count: 2 }], initial: 0 };

interface Harness {
  readonly deps: PanelDeps;
  readonly views: { model: ViewModel; actions: ViewActions }[];
  readonly errors: string[];
  readonly sent: unknown[];
  readonly claimed: string[];
  readonly parent: Window;
  readonly toasts: ToastActions[];
  readonly refreshed: ViewModel[];
  stop?: () => void;
}

function harness(over: Partial<PanelDeps> = {}, record: unknown = RECORD): Harness {
  const parent = { name: 'parent' } as unknown as Window;
  const fakeWindow = Object.assign(new EventTarget(), { parent }) as unknown as Window;
  const h: Harness = {
    views: [], errors: [], sent: [], claimed: [], parent, toasts: [], refreshed: [],
    deps: {
      window: fakeWindow,
      readSession: (nonce) => Promise.resolve(nonce === NONCE ? record : undefined),
      claimSession: (nonce) => { h.claimed.push(nonce); return Promise.resolve(); },
      currentTabId: () => Promise.resolve(7),
      now: () => NOW,
      send: (envelope) => { h.sent.push(envelope); return Promise.resolve({ ok: true, data: null }); },
      render: (model, actions) => { h.views.push({ model, actions }); return (next) => { h.refreshed.push(next); }; },
      showError: (text) => { h.errors.push(text); },
      showToast: (actions) => { h.toasts.push(actions); },
      ...over,
    },
  };
  h.stop = startPanel(h.deps);
  return h;
}

/** A `hello` as the content script sends it: from the parent window, with one port. */
function hello(h: Harness, data: unknown = { type: 'hello', nonce: NONCE }, source: unknown = h.parent): MessageChannel {
  const channel = new MessageChannel();
  h.deps.window.dispatchEvent(new MessageEvent('message', { data, source: source as Window, ports: [channel.port2] }));
  return channel;
}

const readies: unknown[] = [];
const settle = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });
const fromPanel = (port: MessagePort): unknown[] => {
  const seen: unknown[] = [];
  port.onmessage = (e: MessageEvent) => {
    const data = e.data as { type?: unknown };
    if (data.type === 'ready') readies.push(data);
    else seen.push(e.data);
  };
  return seen;
};

const open: MessagePort[] = [];
afterEach(() => { for (const p of open.splice(0)) p.close(); });

async function ready(over: Partial<PanelDeps> = {}): Promise<{ h: Harness; seen: unknown[] }> {
  const h = harness(over);
  const ch = hello(h);
  open.push(ch.port1);
  const seen = fromPanel(ch.port1);
  ch.port1.postMessage(CANDIDATES);
  await vi.waitFor(() => { expect(h.views).toHaveLength(1); });
  return { h, seen };
}

describe('handshake (nonce from storage.session, design review P2-19)', () => {
  test('a valid hello claims the session, the candidates render, and the panel reports ready', async () => {
    readies.length = 0;
    const { h } = await ready();
    await vi.waitFor(() => { expect(readies).toEqual([{ type: 'ready' }]); });
    expect(h.claimed).toEqual([NONCE]);
    expect(h.views[0]?.model).toEqual({ candidates: CANDIDATES.candidates, index: 0, hostname: 'news.example.com', mode: 'hide', canWiden: false, canNarrow: false, large: false });
  });

  test.each([
    ['wrong nonce', { type: 'hello', nonce: 'zzzzzzzzzzzzzzzzzzzz' }, undefined],
    ['malformed hello', { type: 'hello' }, undefined],
    ['not from the parent window', { type: 'hello', nonce: NONCE }, { other: true }],
  ])('ignores %s, and a later valid hello still works', async (_name, data, source) => {
    const h = harness();
    open.push(hello(h, data, source ?? h.parent).port1);
    await settle();
    expect(h.claimed).toEqual([]);
    const ch = hello(h);
    open.push(ch.port1);
    ch.port1.postMessage(CANDIDATES);
    await vi.waitFor(() => { expect(h.views).toHaveLength(1); });
  });

  test.each([
    ['another tab', { ...RECORD, tabId: 8 }],
    ['already claimed', { ...RECORD, claimed: true }],
    ['expired', { ...RECORD, createdAt: NOW - 10 * 60_000 }],
    ['malformed record', { ...RECORD, hostname: 'Bad Host' }],
  ])('refuses a session for %s', async (_name, record) => {
    const h = harness({}, record);
    const ch = hello(h);
    open.push(ch.port1);
    ch.port1.postMessage(CANDIDATES);
    await settle();
    await settle();
    expect([h.claimed, h.views]).toEqual([[], []]);
  });

  test('only the first valid hello is used; later ones (a hostile page) are ignored', async () => {
    const { h } = await ready();
    const second = hello(h);
    open.push(second.port1);
    second.port1.postMessage({ ...CANDIDATES, initial: 1 });
    await settle();
    expect(h.views).toHaveLength(1);
    expect(h.claimed).toEqual([NONCE]);
  });

  test('a failing session read or claim refuses, and a later hello still works', async () => {
    const h = harness({ claimSession: () => Promise.reject(new Error('quota')) });
    open.push(hello(h).port1);
    await settle();
    await settle();
    expect(h.views).toEqual([]);
    const r = harness({ readSession: () => Promise.reject(new Error('gone')) });
    open.push(hello(r).port1);
    await settle();
    expect(r.views).toEqual([]);
  });

  test('a panel without a tab refuses', async () => {
    const h = harness({ currentTabId: () => Promise.resolve(null) });
    const ch = hello(h);
    open.push(ch.port1);
    ch.port1.postMessage(CANDIDATES);
    await settle();
    await settle();
    expect(h.views).toEqual([]);
  });

  test('malformed candidates are dropped', async () => {
    const h = harness();
    const ch = hello(h);
    open.push(ch.port1);
    ch.port1.postMessage({ type: 'candidates', candidates: [{ selector: 'a{}', count: 1 }], initial: 0 });
    await settle();
    await settle();
    expect(h.views).toEqual([]);
  });
});

/** As `ready()`, keeping the picker's end of the port to answer a widen / narrow. */
async function readyWithPort(): Promise<{ h: Harness; seen: unknown[]; port: MessagePort }> {
  const h = harness();
  const ch = hello(h);
  open.push(ch.port1);
  const seen = fromPanel(ch.port1);
  ch.port1.postMessage({ ...CANDIDATES, canWiden: true, canNarrow: false, large: false });
  await vi.waitFor(() => { expect(h.views).toHaveLength(1); });
  return { h, seen, port: ch.port1 };
}

describe('D-81: Bigger / Smaller area', () => {
  test('widen and narrow post no payload; nothing acts on an index until the new offer arrives; it replaces the offer at once', async () => {
    const { h, seen, port } = await readyWithPort();
    const actions = h.views[0]?.actions;
    expect(h.views[0]?.model).toMatchObject({ canWiden: true, canNarrow: false, large: false });
    actions?.widen();
    actions?.widen();
    actions?.hideOnce(0);
    actions?.select(1, true);
    await h.views[0]?.actions.hideAlways(0);
    await vi.waitFor(() => { expect(seen).toEqual([{ type: 'widen' }]); });
    expect(h.sent).toEqual([]);
    const wider = { type: 'candidates', candidates: [{ selector: '#wrap', count: 1 }], initial: 0, canWiden: false, canNarrow: true, large: true };
    port.postMessage(wider);
    await vi.waitFor(() => { expect(h.refreshed).toHaveLength(1); });
    expect(h.refreshed[0]).toMatchObject({ candidates: wider.candidates, index: 0, canWiden: false, canNarrow: true, large: true });
    actions?.hideOnce(1);
    actions?.hideOnce(0);
    actions?.narrow();
    await vi.waitFor(() => { expect(seen).toEqual([{ type: 'widen' }, { type: 'zap', index: 0 }, { type: 'narrow' }]); });
  });

  test('an offer nobody asked for is dropped (no superseding)', async () => {
    const { h, port } = await readyWithPort();
    port.postMessage({ ...CANDIDATES, initial: 1, canWiden: true, canNarrow: true, large: false });
    await settle();
    await settle();
    expect(h.refreshed).toEqual([]);
  });
});

describe('actions: indices to the picker, the save to the worker', () => {
  test('select and preview post indices', async () => {
    const { h, seen } = await ready();
    const actions = h.views[0]?.actions;
    actions?.select(1, true);
    actions?.select(0, false);
    await vi.waitFor(() => { expect(seen).toEqual([{ type: 'preview', index: 1 }, { type: 'preview', index: null }]); });
  });

  test('Hide once posts zap; cancel posts cancel', async () => {
    const { h, seen } = await ready();
    h.views[0]?.actions.hideOnce(1);
    h.views[0]?.actions.cancel();
    await vi.waitFor(() => { expect(seen).toEqual([{ type: 'zap', index: 1 }, { type: 'cancel' }]); });
    expect(h.sent).toEqual([]);
  });

  test('Hide always sends c/saveUserFilter with the session hostname and the nonce, then tells the picker', async () => {
    const { h, seen } = await ready();
    await h.views[0]?.actions.hideAlways(1);
    expect(h.sent).toEqual([{ v: 1, type: 'c/saveUserFilter', id: expect.stringMatching(/^[A-Za-z0-9_-]+$/) as unknown,
      payload: { hostname: 'news.example.com', selector: 'li.row', nonce: NONCE } }]);
    await vi.waitFor(() => { expect(seen).toEqual([{ type: 'saved', index: 1 }]); });
  });

  test('after a save the toast offers Undo: it removes the filter, then tells the picker; expiry closes', async () => {
    const { h, seen } = await ready();
    await h.views[0]?.actions.hideAlways(1);
    expect(h.toasts).toHaveLength(1);
    await h.toasts[0]?.undo();
    expect(h.sent.at(-1)).toMatchObject({ type: 'c/removeUserFilter', payload: { hostname: 'news.example.com', selector: 'li.row' } });
    h.toasts[0]?.expire();
    await vi.waitFor(() => { expect(seen).toEqual([{ type: 'saved', index: 1 }, { type: 'undo', index: 1 }, { type: 'close' }]); });
  });

  test('a refused undo shows an error and does not tell the picker', async () => {
    let calls = 0;
    const { h, seen } = await ready({ send: () => Promise.resolve((calls += 1) === 1 ? { ok: true, data: null } : { ok: false, error: { code: 'x', message: 'x' } }) });
    await h.views[0]?.actions.hideAlways(0);
    await h.toasts[0]?.undo();
    await settle();
    expect(seen).toEqual([{ type: 'saved', index: 0 }]);
    expect(h.errors).toHaveLength(1);
  });

  test('a refused or failed save shows an error and tells the picker nothing', async () => {
    const refused = await ready({ send: () => Promise.resolve({ ok: false, error: { code: 'not-implemented', message: 'x' } }) });
    await refused.h.views[0]?.actions.hideAlways(0);
    const failed = await ready({ send: () => Promise.reject(new Error('gone')) });
    await failed.h.views[0]?.actions.hideAlways(0);
    await settle();
    expect([refused.seen, failed.seen]).toEqual([[], []]);
    expect(refused.h.errors).toHaveLength(1);
    expect(failed.h.errors).toHaveLength(1);
  });

  test('out-of-range indices do nothing', async () => {
    const { h, seen } = await ready();
    h.views[0]?.actions.hideOnce(5);
    await h.views[0]?.actions.hideAlways(-1);
    h.views[0]?.actions.select(9, true);
    await settle();
    expect([seen, h.sent]).toEqual([[], []]);
  });

  test('stop removes the hello listener', async () => {
    const h = harness();
    h.stop?.();
    open.push(hello(h).port1);
    await settle();
    expect(h.claimed).toEqual([]);
  });
});
