// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PanelEnv } from '../../../../src/content/picker/channel.js';
import type { CandidatesMessage, PanelMessage } from '../../../../src/core/picker/protocol.js';
import type { PickHint } from '../../../../src/core/picker/hint.js';
import type { Probe } from '../../../../src/core/picker/rank.js';

const LABELS = { overlay: 'Pick an element', panel: 'The panel title', hint: 'Click to pick. Esc cancels.' };

const opened: PanelEnv[] = [];
const running: (() => void)[] = [];
const closed = vi.fn();
const toasted = vi.fn();
const offers: CandidatesMessage[] = [];
vi.mock('../../../../src/content/picker/channel.js', () => ({
  openPanel: (env: PanelEnv) => {
    opened.push(env);
    return { close: closed, toast: toasted, offer: (c: CandidatesMessage) => { offers.push(c); } };
  },
}));

const { candidatesFor, probeFor, runPicker } = await import('../../../../src/content/picker/controller.js');

class FakeSheet {
  text = '';
  replaceSync(text: string): void { this.text = text; }
}

const query = (selector: string): readonly Element[] => [...document.querySelectorAll(selector)];
const probe: Probe = (selector) => probeFor(document.getElementById('t') as Element, query)(selector);

const LIST = '<ul class="list"><li class="row">a</li><li class="row" id="t">b</li></ul>';

type Rect = NonNullable<Parameters<typeof runPicker>[0]['rect']>;

function start(over: { query?: (s: string) => readonly Element[]; html?: string; hint?: PickHint; rect?: Rect } = {}) {
  Object.defineProperty(document, 'adoptedStyleSheets', { value: [], writable: true, configurable: true });
  document.body.innerHTML = over.html ?? LIST;
  const sheets: FakeSheet[] = [];
  const onEnd = vi.fn();
  const stop = runPicker({
    document, window, query: over.query ?? query, panelUrl: 'chrome-extension://abc/picker-panel.html', panelOrigin: 'chrome-extension://abc', labels: LABELS, setTimer: () => () => undefined, onEnd,
    elementsFromPoint: () => [document.getElementById('t') as Element],
    newSheet: () => { const s = new FakeSheet(); sheets.push(s); return s; },
    isTrusted: () => true, hasBox: () => true, ...(over.rect && { rect: over.rect }),
  }, 'abcdefghijklmnop1234', over.hint ?? null);
  running.push(stop);
  return { sheets, onEnd, stop };
}
const enter = (): boolean => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));

afterEach(() => {
  for (const stop of running.splice(0)) stop();
  opened.length = 0;
  offers.length = 0;
  closed.mockClear();
  document.documentElement.querySelectorAll(':scope > div').forEach((n) => { n.remove(); });
});

describe('candidatesFor', () => {
  test('slider order narrow → wide, best-ranked marked as initial', () => {
    document.body.innerHTML = '<ul class="list"><li class="row">a</li><li class="row" id="t">b</li></ul>';
    const c = candidatesFor(document.getElementById('t') as Element, probe);
    expect(c?.candidates[c.initial]?.selector).toBe('#t');
    const counts = c?.candidates.map((x) => x.count) ?? [];
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  test('nothing usable → null', () => {
    document.body.innerHTML = '<p id="t">x</p>';
    expect(candidatesFor(document.getElementById('t') as Element, () => null)).toBeNull();
  });
});

describe('runPicker', () => {
  test('a pick opens the panel with the nonce and the candidates; the overlay mounts it', () => {
    start();
    enter();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.nonce).toBe('abcdefghijklmnop1234');
    expect(opened[0]?.candidates.type).toBe('candidates');
  });

  test('a context-menu hint picks the matching image at once (P3-17); the panel offers its candidates', () => {
    start({ html: `${LIST}<img id="pic" src="https://cdn.example/p.png">`, hint: { kind: 'image', url: 'https://cdn.example/p.png' } });
    expect(opened).toHaveLength(1);
    const offer = opened[0]?.candidates;
    expect(offer?.candidates[offer.initial]?.selector).toBe('#pic');
  });

  test('D-104: labels.hint reaches the overlay pill; a matching context-menu hint leaves the pill hidden', () => {
    start({ html: `${LIST}<img id="pic" src="https://cdn.example/p.png">`, hint: { kind: 'image', url: 'https://cdn.example/p.png' } });
    const probe = document.createElement('span');
    opened[0]?.mount(probe);
    const pill = (probe.getRootNode() as ShadowRoot).querySelector<HTMLElement>('[data-hint]');
    expect(pill?.textContent).toBe(LABELS.hint);
    expect(pill?.style.getPropertyValue('display')).toBe('none');
  });

  test('a hint matching nothing: the picker waits for a pick as before', () => {
    start({ hint: { kind: 'frame', url: 'https://ads.example/f.html' } });
    expect(opened).toHaveLength(0);
    enter();
    expect(opened).toHaveLength(1);
  });

  test('D-81: widen / narrow move along the chain and answer with a fresh offer and its flags', () => {
    const sizes: Readonly<Record<string, number>> = { t: 10, list: 40, wrap: 40, outer: 700 };
    const rect: Rect = (el) => ({ left: 0, top: 0, width: sizes[el.id] ?? 0, height: (sizes[el.id] ?? 0) > 100 ? 600 : 10 });
    start({ html: '<div id="outer"><div id="wrap"><ul class="list" id="list"><li class="row">a</li><li class="row" id="t">b</li></ul></div></div>', rect });
    enter();
    const first = opened[0]?.candidates;
    expect([first?.canWiden, first?.canNarrow, first?.large]).toEqual([true, false, false]);
    const send = (m: PanelMessage): void => { opened[0]?.onMessage(m); };
    send({ type: 'widen' });
    expect(offers.at(-1)?.candidates.some((c) => c.selector === '#list')).toBe(true);
    expect([offers.at(-1)?.canWiden, offers.at(-1)?.canNarrow, offers.at(-1)?.large]).toEqual([true, true, false]);
    send({ type: 'widen' });
    expect(offers.at(-1)?.candidates.some((c) => c.selector === '#outer')).toBe(true);
    expect([offers.at(-1)?.canWiden, offers.at(-1)?.large]).toEqual([false, true]);
    send({ type: 'widen' });
    expect(offers).toHaveLength(3);
    expect(offers.at(-1)?.canWiden).toBe(false);
    send({ type: 'narrow' });
    send({ type: 'narrow' });
    expect(offers.at(-1)?.candidates[offers.at(-1)?.initial ?? 0]?.selector).toBe('#t');
    expect(offers.at(-1)?.canNarrow).toBe(false);
  });

  test('D-81: an index after a widen reads the new offer', () => {
    const sizes: Readonly<Record<string, number>> = { t: 10, list: 40 };
    const { sheets } = start({ html: '<ul class="list" id="list"><li class="row">a</li><li class="row" id="t">b</li></ul>', rect: (el) => ({ left: 0, top: 0, width: sizes[el.id] ?? 0, height: 10 }) });
    enter();
    opened[0]?.onMessage({ type: 'widen' });
    const offer = offers.at(-1);
    const at = offer?.candidates.findIndex((c) => c.selector === '#list') ?? -1;
    opened[0]?.onMessage({ type: 'preview', index: at });
    expect(sheets[0]?.text).toBe('#list{display:none!important}');
  });

  test('no candidate: the panel does not open and picking resumes', () => {
    start({ query: () => { throw new SyntaxError('refused'); } });
    enter();
    expect(opened).toHaveLength(0);
    enter();
    expect(opened).toHaveLength(0);
  });

  test('preview applies and removes a sanitised hide rule; zap keeps it and ends', () => {
    const { sheets, onEnd } = start();
    enter();
    const env = opened[0];
    if (env === undefined) throw new Error('panel not opened');
    const i = env.candidates.initial;
    env.onMessage({ type: 'preview', index: i });
    expect(sheets[0]?.text).toBe('#t{display:none!important}');
    env.onMessage({ type: 'preview', index: null });
    expect(sheets[0]?.text).toBe('');
    env.onMessage({ type: 'zap', index: i });
    expect(sheets[1]?.text).toBe('#t{display:none!important}');
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    env.onMessage({ type: 'cancel' });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test('saved keeps the element hidden and shrinks the panel to the toast; undo un-hides and ends; close ends', () => {
    const a = start();
    enter();
    opened[0]?.onMessage({ type: 'saved', index: 0 });
    expect(a.sheets[1]?.text).toMatch(/\{display:none!important\}$/);
    expect(a.onEnd).not.toHaveBeenCalled();
    opened[0]?.onMessage({ type: 'undo', index: 0 });
    expect(a.sheets[1]?.text).toBe('');
    expect(a.onEnd).toHaveBeenCalledTimes(1);
    opened.length = 0;
    a.stop();
    const b = start();
    enter();
    opened[0]?.onMessage({ type: 'saved', index: 0 });
    opened[0]?.onMessage({ type: 'close' });
    expect(b.sheets[1]?.text).toMatch(/display:none/);
    expect(b.onEnd).toHaveBeenCalledTimes(1);
    opened.length = 0;
    b.stop();
    const c = start();
    enter();
    opened[0]?.onMessage({ type: 'cancel' });
    expect(c.sheets[1]?.text).toBe('');
    expect(c.onEnd).toHaveBeenCalledTimes(1);
    c.stop();
    const d = start();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(d.onEnd).toHaveBeenCalledTimes(1);
  });

  test('adopts its sheets into the page document; a document that refuses still gets a picker', () => {
    start();
    expect(document.adoptedStyleSheets).toHaveLength(2);
    Object.defineProperty(document, 'adoptedStyleSheets', { get: () => [], set: () => { throw new TypeError('no'); }, configurable: true });
    const onEnd = vi.fn();
    runPicker({ document, window, query, panelUrl: 'chrome-extension://abc/picker-panel.html', panelOrigin: 'chrome-extension://abc', labels: LABELS, setTimer: () => () => undefined, onEnd, elementsFromPoint: () => [], newSheet: () => new FakeSheet() }, 'abcdefghijklmnop1234')();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
