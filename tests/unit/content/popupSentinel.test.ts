// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import type { NoticeAction } from '../../../src/content/popup-sentinel/notice.js';
import { startSentinel, type SentinelEnv } from '../../../src/content/popup-sentinel/sentinel.js';
import { english } from '../../helpers/chromeI18n.js';
import { isElement, isHijackOverlay, isInteractive, linkOf, type View } from '../../../src/content/popup-sentinel/signals.js';

const VIEW_W = 1000;
const VIEW_H = 800;

function rect(el: Element, x: number, y: number, w: number, h: number): void {
  el.getBoundingClientRect = () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON: () => ({}) });
}

function view(styles: Readonly<Record<string, Partial<CSSStyleDeclaration>>> = {}): View {
  const base = { cursor: 'auto', position: 'static', zIndex: 'auto', opacity: '1', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', visibility: 'visible' };
  return { innerWidth: VIEW_W, innerHeight: VIEW_H, getComputedStyle: (el) => Object.assign({}, base, styles[el.id] ?? {}) as unknown as CSSStyleDeclaration };
}

describe('signals (pop-up notes §7.2, §7.4)', () => {
  test('interactive: a small control or an ancestor with cursor:pointer; not when huge', () => {
    document.body.innerHTML = '<button id="b"><span id="s">x</span></button><div id="d"><i id="i">x</i></div><div id="p"><b id="q">x</b></div>';
    for (const id of ['b', 's', 'd', 'i', 'p', 'q']) rect(document.getElementById(id) as Element, 0, 0, 100, 40);
    expect(isInteractive(document.getElementById('s') as Element, view())).toBe(true);
    expect(isInteractive(document.getElementById('i') as Element, view())).toBe(false);
    expect(isInteractive(document.getElementById('q') as Element, view({ p: { cursor: 'pointer' } }))).toBe(true);
    rect(document.getElementById('b') as Element, 0, 0, VIEW_W, VIEW_H);
    expect(isInteractive(document.getElementById('s') as Element, view())).toBe(false);
  });

  test('hijack overlay: full viewport, positioned, empty, transparent', () => {
    document.body.innerHTML = '<div id="o"></div><div id="t">text</div><div id="m"><img></div>';
    for (const id of ['o', 't', 'm']) rect(document.getElementById(id) as Element, 0, 0, VIEW_W, VIEW_H);
    const fixed = { position: 'fixed', opacity: '0' };
    expect(isHijackOverlay(document.getElementById('o') as Element, view({ o: fixed }))).toBe(true);
    expect(isHijackOverlay(document.getElementById('o') as Element, view({ o: { position: 'fixed', backgroundColor: 'rgba(0, 0, 0, 0.6)' } }))).toBe(false);
    expect(isHijackOverlay(document.getElementById('o') as Element, view({ o: { ...fixed, backgroundImage: 'url(x)' } }))).toBe(false);
    expect(isHijackOverlay(document.getElementById('o') as Element, view())).toBe(false);
    expect(isHijackOverlay(document.getElementById('t') as Element, view({ t: fixed }))).toBe(false);
    expect(isHijackOverlay(document.getElementById('m') as Element, view({ m: fixed }))).toBe(false);
    rect(document.getElementById('o') as Element, 0, 0, 500, VIEW_H);
    expect(isHijackOverlay(document.getElementById('o') as Element, view({ o: fixed }))).toBe(false);
  });

  test('link: the nearest a[href]; fragment and javascript: links are none; visibility', () => {
    document.body.innerHTML = '<a id="a" href="https://x.example/p"><span id="s">x</span></a><a id="h" href="#top"><i id="i">x</i></a>';
    rect(document.getElementById('a') as Element, 0, 0, 50, 20);
    expect(linkOf(document.getElementById('s') as Element, view())).toMatchObject({ href: 'https://x.example/p', visible: true });
    expect(linkOf(document.getElementById('s') as Element, view({ a: { visibility: 'hidden' } }))?.visible).toBe(false);
    expect(linkOf(document.getElementById('i') as Element, view())).toBeNull();
  });
});

/** A fresh window per sentinel (an iframe), so listeners of earlier tests do not see the clicks. */
function frameWindow(html: string): Window {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const w = frame.contentWindow;
  if (w === null) throw new Error('no frame window');
  w.document.body.innerHTML = html;
  for (const a of w.document.querySelectorAll('a')) rect(a, 0, 0, 50, 20);
  return w;
}

function env(over: Partial<SentinelEnv> = {}, html = '<a id="a" target="_blank" href="https://ad.example/x">ad</a>') {
  const shown: { text: string; subject: string; actions: readonly NoticeAction[] }[] = [];
  const navigation = new EventTarget();
  let now = 1_000;
  const w = frameWindow(html);
  const e: SentinelEnv & { readonly window: Window & { readonly navigation: EventTarget } } = {
    window: Object.assign(w as Window & typeof globalThis, { navigation }), view: view(), now: () => now, strict: () => false, quiet: () => false, open: vi.fn(), secret: 'xsecret123', arm: vi.fn(), say: (key) => english(key),
    notice: { show: (text, subject, actions) => { shown.push({ text, subject, actions }); }, owns: () => false }, ...over,
  };
  const el = (id: string): Element => {
    const found = w.document.getElementById(id);
    if (found === null) throw new Error(`no #${id}`);
    return found;
  };
  return { e, shown, navigation, el, advance: (ms: number) => { now += ms; } };
}

const click = (el: Element): MouseEvent => {
  const ev = new (el.ownerDocument.defaultView ?? window).MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
};

describe('sentinel (P2-57)', () => {
  test('a script-made click on a target=_blank link with no gesture: Smart lets Chrome decide (G12), Strict blocks with a notice', () => {
    const smart = env();
    const s1 = startSentinel(smart.e);
    expect(click(smart.el('a')).defaultPrevented).toBe(false);
    expect(s1.answer({ type: 'x/popupLog' })).toEqual({ hosts: [], blocked: 0, codes: [] });
    const strict = env({ strict: () => true });
    const s2 = startSentinel(strict.e);
    expect(click(strict.el('a')).defaultPrevented).toBe(true);
    expect(strict.shown[0]?.text).toBe('Pop-up blocked · ad.example');
    expect(s2.answer({ type: 'x/popupLog' })).toMatchObject({ hosts: ['ad.example'], blocked: 1 });
    strict.shown[0]?.actions[0]?.run();
    expect(strict.e.open).toHaveBeenCalledWith('https://ad.example/x');
  });

  test('a link whose href hides javascript: behind a tab is blocked without an "Open it" (review MEDIUM-2)', () => {
    const strict = env({ strict: () => true }, '<a id="a" target="_blank" href="java&#9;script:alert(1)">x</a>');
    startSentinel(strict.e);
    expect(click(strict.el('a')).defaultPrevented).toBe(true);
    expect(strict.shown[0]?.actions.map((a) => a.label)).toEqual(['Allow on this page']);
  });

  test('a same-tab link is never judged', () => {
    const strict = env({ strict: () => true }, '<a id="a" href="https://ad.example/x">ad</a>');
    startSentinel(strict.e);
    expect(click(strict.el('a')).defaultPrevented).toBe(false);
  });

  test('tab-under: a script navigation to another site right after a new context is cancelled; user, reload and late ones are not', () => {
    const t = env();
    startSentinel(t.e);
    click(t.el('a'));
    const nav = (url: string, extra: object = {}): Event => {
      const ev = Object.assign(new Event('navigate', { cancelable: true }), { destination: { url }, userInitiated: false, navigationType: 'push' }, extra);
      t.navigation.dispatchEvent(ev);
      return ev;
    };
    // (Same-site navigations are left alone: covered in the E2E, the frame here has no host.)
    expect(nav('https://tab-under.example/', { navigationType: 'reload' }).defaultPrevented).toBe(false);
    expect(nav('https://tab-under.example/', { userInitiated: true }).defaultPrevented).toBe(false);
    expect(nav('https://tab-under.example/').defaultPrevented).toBe(true);
    expect(t.shown.at(-1)?.text).toBe('Stopped a redirect to tab-under.example');
    expect(t.shown.at(-1)?.actions[0]?.label).toBe('Go there');
    click(t.el('a'));
    t.advance(3_000);
    expect(nav('https://tab-under.example/').defaultPrevented).toBe(false);
  });

  test('answers: link check is false without a real click; popupClosed shows the notice; unknown → undefined', () => {
    const t = env();
    const s = startSentinel(t.e);
    expect(s.answer({ type: 'x/linkClickCheck', host: 'ad.example' })).toBe(false);
    expect(s.answer({ type: 'x/popupClosed', host: 'pop.example' })).toBe(true);
    expect(t.shown[0]?.text).toBe('Pop-up blocked · pop.example');
    expect(s.answer({ type: 'x/popupLog' })).toMatchObject({ hosts: ['pop.example'], blocked: 1 });
    expect([s.answer(null), s.answer({ type: 'x/other', host: 'a' }), s.answer({ type: 'x/linkClickCheck' })]).toEqual([undefined, undefined, undefined]);
  });

  test('"Allow on this page" lets later windows through and asks the user to repeat the click', () => {
    const strict = env({ strict: () => true });
    startSentinel(strict.e);
    click(strict.el('a'));
    expect(strict.shown[0]?.actions.map((a) => a.label)).toEqual(['Open it', 'Allow on this page']);
    expect(strict.shown[0]?.subject).toBe('ad.example');
    expect(strict.shown[0]?.actions[1]?.run()).toBe('Now repeat what you did');
    expect(click(strict.el('a')).defaultPrevented).toBe(false);
  });

  test('P2-59: Open it opens the blocked address and closes the notice; a closed destination offers Open it only', () => {
    const t = env({ strict: () => true });
    const s = startSentinel(t.e);
    click(t.el('a'));
    expect(t.shown[0]?.actions[0]?.run()).toBeUndefined();
    expect(t.e.open).toHaveBeenCalledWith('https://ad.example/x');
    s.answer({ type: 'x/popupClosed', host: 'pop.example' });
    expect(t.shown[1]?.actions.map((a) => a.label)).toEqual(['Open it']);
    t.shown[1]?.actions[0]?.run();
    expect(t.e.open).toHaveBeenLastCalledWith('https://pop.example/');
  });

  test('P2-59: with the notice turned off (popup-quiet) nothing is drawn; blocking, count and log are unchanged', () => {
    const t = env({ strict: () => true, quiet: () => true });
    const s = startSentinel(t.e);
    expect(click(t.el('a')).defaultPrevented).toBe(true);
    expect(t.shown).toEqual([]);
    expect(s.answer({ type: 'x/popupLog' })).toMatchObject({ hosts: ['ad.example'], blocked: 1 });
  });
});

describe('handshake and window.open (P2-58)', () => {
  test('announces the secret, answers one hello, and blocks a no-gesture open in Strict', () => {
    const t = env({ strict: () => true });
    const seen: unknown[] = [];
    t.e.window.document.addEventListener('x-gb', (e) => { seen.push((e as CustomEvent).detail); });
    startSentinel(t.e);
    t.e.window.document.dispatchEvent(new t.e.window.CustomEvent('x-gh'));
    t.e.window.document.dispatchEvent(new t.e.window.CustomEvent('x-gh'));
    // Once at start, once for the first hello; a second hello (a page later) gets nothing.
    expect(seen).toEqual(['xsecret123', 'xsecret123']);
    const ask = (url: string): boolean => t.e.window.document.dispatchEvent(new t.e.window.CustomEvent('xsecret123', { detail: url, cancelable: true }));
    expect(ask('https://ads.example/x')).toBe(false);
    expect(t.shown.at(-1)?.text).toBe('Pop-up blocked · ads.example');
    // A listed provider endpoint is allowed even in Strict (G5).
    expect(ask('https://accounts.google.com/o/oauth2/auth?x=1')).toBe(true);
  });

  test('Smart lets a no-gesture open through (G12); the opened-check confirms it once, for that host only', () => {
    const t = env();
    const s = startSentinel(t.e);
    expect(s.answer({ type: 'x/openedCheck', host: 'ads.example' })).toBe(false);
    expect(t.e.window.document.dispatchEvent(new t.e.window.CustomEvent('xsecret123', { detail: 'https://ads.example/', cancelable: true }))).toBe(true);
    expect(s.answer({ type: 'x/openedCheck', host: 'other.example' })).toBe(false);
    expect(s.answer({ type: 'x/openedCheck', host: 'ads.example' })).toBe(true);
    expect(s.answer({ type: 'x/openedCheck', host: 'ads.example' })).toBe(false);
    // An unknown destination (about:blank, then navigated) matches any host once; it expires after the gesture window.
    t.e.window.document.dispatchEvent(new t.e.window.CustomEvent('xsecret123', { detail: 'about:blank', cancelable: true }));
    t.advance(6_000);
    expect(s.answer({ type: 'x/openedCheck', host: 'ads.example' })).toBe(false);
    t.e.window.document.dispatchEvent(new t.e.window.CustomEvent('xsecret123', { detail: '', cancelable: true }));
    expect(s.answer({ type: 'x/openedCheck', host: 'any.example' })).toBe(true);
  });
});


describe('P2-43 security review: hostile pages cannot slip a window past the judge', () => {
  test('window.open resolves against the document base URL (<base href>), as the native call does', () => {
    const t = env({ strict: () => true }, '<base href="https://ads.example/"><a id="a" href="x">x</a>');
    const s = startSentinel(t.e);
    t.e.window.document.dispatchEvent(new t.e.window.CustomEvent('xsecret123', { detail: '/pop', cancelable: true }));
    expect(s.answer({ type: 'x/popupLog' })).toMatchObject({ hosts: ['ads.example'], blocked: 1 });
    expect(t.shown[0]?.subject).toBe('ads.example');
  });

  test('a notice that throws (a clobbered document) never turns a block into an allow', () => {
    const boom = { show: () => { throw new Error('clobbered'); }, owns: () => false };
    const t = env({ strict: () => true, notice: boom });
    startSentinel(t.e);
    const allowed = t.e.window.document.dispatchEvent(new t.e.window.CustomEvent('xsecret123', { detail: 'https://ads.example/', cancelable: true }));
    expect(allowed).toBe(false);
    expect(click(t.el('a')).defaultPrevented).toBe(true);
  });

  test('form named properties (<input name=closest|nodeType>) do not hide a link or an element', () => {
    const t = env({ strict: () => true }, '<a id="a" target="_blank" href="https://ad.example/x"><form id="f"><input name="closest"><input name="matches"></form></a><form id="g"><input name="nodeType"></form>');
    // jsdom lacks the [LegacyOverrideBuiltIns] named getters Chrome has; own properties stand in for them
    // (`nodeType` on a form of its own: jsdom's selector engine, unlike Chrome's, reads it from the wrapper).
    const shadow = (form: Element): void => { for (const input of [...form.querySelectorAll('input')]) Object.defineProperty(form, input.name, { value: input }); };
    const [form, other] = [t.el('f'), t.el('g')];
    shadow(form);
    shadow(other);
    expect(isElement(other)).toBe(true);
    expect(linkOf(form, view())?.href).toBe('https://ad.example/x');
    startSentinel(t.e);
    expect(click(form).defaultPrevented).toBe(true);
  });
});

describe('lazy extension listener (D-42b): our pages read the same as with a listener from load', () => {
  /** The callers' reading: no receiver is "no"; blocked.html sends popupClosed only after openedCheck is true. */
  const callerView = (ask: (m: object) => unknown, host: string) => {
    const opened = ask({ type: 'x/openedCheck', host }) === true;
    const link = ask({ type: 'x/linkClickCheck', host }) === true;
    const notice = opened && ask({ type: 'x/popupClosed', host }) === true;
    const log = (ask({ type: 'x/popupLog' }) as { readonly hosts?: readonly string[] } | undefined)?.hosts ?? [];
    return { opened, link, notice, log };
  };
  type Rig = ReturnType<typeof env>;
  const shimOpen = (t: Rig): void => { t.e.window.document.dispatchEvent(new t.e.window.CustomEvent('xsecret123', { detail: 'https://ads.example/', cancelable: true })); };
  test.each<[string, (t: Rig) => void, string, boolean]>([
    ['a gesture in the top document (a click on a pop-up link)', (t) => { click(t.el('a')); }, 'ad.example', true],
    ['a gesture inside a frame: the top window only loses focus', (t) => { t.e.window.dispatchEvent(new t.e.window.FocusEvent('blur')); }, 'ad.example', true],
    ['no gesture: a script open through the shim', shimOpen, 'ads.example', true],
    ['no event at all', () => undefined, 'ads.example', false],
  ])('%s', (_name, act, host, arms) => {
    const eager = env();
    const always = startSentinel(eager.e);
    act(eager);
    let armed = false;
    const lazy = env({ arm: () => { armed = true; } });
    const late = startSentinel(lazy.e);
    act(lazy);
    expect(armed).toBe(arms);
    expect(callerView((m) => (armed ? late.answer(m) : undefined), host)).toEqual(callerView((m) => always.answer(m), host));
  });
});
