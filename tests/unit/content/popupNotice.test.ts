// @vitest-environment jsdom
/**
 * P2-59, the in-page notice in jsdom: one host at a time in a closed root, coalesced count, every inline
 * declaration `!important` (so the page's static flow cannot move it), a labelled dismiss button, the live
 * region filled after insertion, the visibility watch (IntersectionObserver v2, fail closed), and untrusted
 * events doing nothing. jsdom cannot make trusted events: the accepted-click path is E2E (`hostile/sentinel`,
 * `journeyPopupControls`).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createNotice, visibilityWatch, type Watch } from '../../../src/content/popup-sentinel/notice.js';
import { axeViolations } from '../ui/axe.js';
import { english } from '../../helpers/chromeI18n.js';

/** The notice's words, as the entry script passes them from `_locales` (P2-40). */
const say = (key: string): string => english(key);

const always: Watch = () => ({ visible: () => true, stop: () => undefined });

function capture(): { roots: ShadowRoot[] } {
  const roots: ShadowRoot[] = [];
  const { attachShadow } = Object.getOwnPropertyDescriptors(Element.prototype);
  const attach = attachShadow.value as (this: Element, init: ShadowRootInit) => ShadowRoot;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = attach.call(this, init);
    roots.push(root);
    return root;
  });
  return { roots };
}

const hosts = (): Element[] => [...document.documentElement.children].filter((c) => c.tagName === 'DIV');

afterEach(() => {
  vi.restoreAllMocks();
  for (const h of hosts()) h.remove();
});

describe('notice (P2-57, P2-59)', () => {
  test('one at a time in a closed root; further blocks coalesce into a count; hides after its time', () => {
    const { roots } = capture();
    const timers: (() => void)[] = [];
    const n = createNotice(document, () => 0, (run) => { timers.push(run); return () => undefined; }, always, say);
    const run = vi.fn(() => undefined);
    n.show('Pop-up blocked · a.example', 'a.example', [{ label: 'Open it', run }]);
    n.show('Pop-up blocked · b.example', 'b.example', [{ label: 'Open it', run }]);
    expect(hosts()).toHaveLength(1);
    expect(hosts()[0]?.shadowRoot).toBeNull();
    expect([n.owns(hosts()[0]), n.owns(document.body), n.owns(null)]).toEqual([true, false, false]);
    expect(roots.at(-1)?.querySelector('[role=status]')?.textContent).toBe('2 pop-ups blocked · b.example');
    expect([...(roots.at(-1)?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Open it', 'Dismiss']);
    timers.at(-1)?.();
    expect(hosts()).toHaveLength(0);
    n.show('Pop-up blocked · c.example', 'c.example', []);
    expect(roots.at(-1)?.querySelector('[role=status]')?.textContent).toBe('Pop-up blocked · c.example');
    expect(run).not.toHaveBeenCalled();
  });

  test('axe: the notice content (status line, named buttons) has no violations (rendered open here so axe can enter it)', async () => {
    const attach = Object.getOwnPropertyDescriptors(Element.prototype).attachShadow.value as (this: Element, init: ShadowRootInit) => ShadowRoot;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element) { return attach.call(this, { mode: 'open' }); });
    const n = createNotice(document, () => 0, () => () => undefined, always, say);
    n.show('Pop-up blocked · a.example', 'a.example', [{ label: 'Open it', run: () => undefined }, { label: 'Allow on this page', run: () => undefined }]);
    const host = hosts()[0];
    if (host === undefined) throw new Error('no notice');
    expect(host.shadowRoot?.querySelectorAll('button')).toHaveLength(3);
    expect(await axeViolations(host)).toEqual([]);
  });

  test('every declaration on the host is !important (a plain one after all:initial!important loses)', () => {
    const n = createNotice(document, () => 0, () => () => undefined, always, say);
    n.show('Pop-up blocked · a.example', 'a.example', []);
    const style = (hosts()[0] as HTMLElement).style;
    expect(style.length).toBeGreaterThan(0);
    expect([...Array.from({ length: style.length }, (_, i) => style.item(i))].filter((p) => style.getPropertyPriority(p) !== 'important')).toEqual([]);
    expect(['position', 'top', 'z-index'].map((p) => style.getPropertyValue(p))).toEqual(['fixed', '12px', '2147483647']);
  });

  test('untrusted clicks and an untrusted Escape do nothing; the watch stops with the notice', () => {
    const { roots } = capture();
    const stop = vi.fn();
    const n = createNotice(document, () => 10_000, () => () => undefined, () => ({ visible: () => true, stop }), say);
    const run = vi.fn(() => undefined);
    n.show('Pop-up blocked · a.example', 'a.example', [{ label: 'Open it', run }]);
    for (const b of roots.at(-1)?.querySelectorAll('button') ?? []) b.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(run).not.toHaveBeenCalled();
    expect(hosts()).toHaveLength(1);
    n.show('Pop-up blocked · b.example', 'b.example', []);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('visibility watch (IntersectionObserver v2)', () => {
  test('visible only after 400 ms of continuous visible reports; a hidden report restarts; no v2 → never', () => {
    let t = 0;
    let report: (entries: { intersectionRatio: number; isVisible?: boolean }[]) => void = () => undefined;
    const disconnect = vi.fn();
    class FakeObserver {
      constructor(cb: typeof report, readonly options: object) { report = cb; }
      observe(): void { /* reports come from the test */ }
      disconnect(): void { disconnect(); }
    }
    const w = visibilityWatch({ IntersectionObserver: FakeObserver }, () => t)(document.body);
    expect(w.visible()).toBe(false);
    report([{ intersectionRatio: 1, isVisible: true }]);
    t = 399;
    expect(w.visible()).toBe(false);
    t = 400;
    expect(w.visible()).toBe(true);
    report([{ intersectionRatio: 1, isVisible: false }]);
    expect(w.visible()).toBe(false);
    report([{ intersectionRatio: 0.9, isVisible: true }]);
    t = 2_000;
    expect(w.visible()).toBe(false);
    report([{ intersectionRatio: 1 }]);
    t = 3_000;
    expect(w.visible()).toBe(false);
    w.stop();
    expect(disconnect).toHaveBeenCalled();
    const none = visibilityWatch({}, () => t)(document.body);
    t = 9_000;
    expect(none.visible()).toBe(false);
    none.stop();
  });
});
