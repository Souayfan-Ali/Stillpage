// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { describeElement } from '../../../../src/content/picker/describe.js';
import { createOverlay, MAX_PROMOTIONS, type OverlayEnv } from '../../../../src/content/picker/overlay.js';
import { step } from '../../../../src/content/picker/traverse.js';

/** Markup in the hint must stay text (D-104). */
const HINT = 'Click what you want to hide. <b>Esc</b> cancels.';

const html = `
  <header id="top"><nav class="menu">n</nav></header>
  <main><section class="feed"><article class="card">a</article><article class="card" id="second">b</article><article class="card">c</article></section></main>
  <script>/* not selectable */</script>`;

function env(over: Partial<OverlayEnv> = {}): OverlayEnv & { picked: Element[]; cancelled: number } {
  const out = {
    document, window,
    elementsFromPoint: (): readonly Element[] => [last(), document.getElementById('second') as Element],
    isTrusted: () => true,
    hasBox: () => true,
    onPick: (el: Element) => { out.picked.push(el); },
    onCancel: () => { out.cancelled += 1; },
    label: 'Pick an element',
    hint: HINT,
    picked: [] as Element[], cancelled: 0,
    ...over,
  };
  return out;
}

function must<T>(x: T | null): T {
  if (x === null) throw new Error('fixture element missing');
  return x;
}
const last = (): Element => must(document.documentElement.lastElementChild);
const key = (k: string): KeyboardEvent => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });

afterEach(() => { document.documentElement.querySelectorAll(':scope > *:not(head):not(body)').forEach((n) => { n.remove(); }); });

describe('step: keyboard traversal (UI notes §5)', () => {
  test('up = parent, down = first child, left/right = siblings; stays put at the edges', () => {
    document.body.innerHTML = html;
    const second = document.getElementById('second') as Element;
    const ours = (): boolean => false;
    expect(step(second, 'ArrowUp', ours).className).toBe('feed');
    expect(step(second, 'ArrowLeft', ours).textContent).toBe('a');
    expect(step(second, 'ArrowRight', ours).textContent).toBe('c');
    expect(step(second.parentElement as Element, 'ArrowDown', ours).textContent).toBe('a');
    expect(step(second, 'ArrowDown', ours)).toBe(second);
    expect(step(document.body, 'ArrowUp', ours)).toBe(document.body);
    expect(step(document.querySelector('main') as Element, 'ArrowUp', ours)).toBe(document.body);
    const last = must(second.nextElementSibling);
    expect(step(last, 'ArrowRight', ours)).toBe(last);
  });

  test('skips our own host element and non-visual elements', () => {
    document.body.innerHTML = html;
    const main = document.querySelector('main') as Element;
    expect(step(main, 'ArrowRight', () => false)).toBe(main);
    const host = document.createElement('div');
    main.after(host);
    expect(step(main, 'ArrowRight', (e) => e === host)).toBe(main);
  });
});

describe('describeElement', () => {
  test('tag, id or first class, size', () => {
    document.body.innerHTML = html;
    const rect = { width: 300.4, height: 250 } as DOMRect;
    expect(describeElement(document.getElementById('second') as Element, rect)).toBe('article#second, 300 × 250');
    expect(describeElement(must(document.querySelector('.menu')), rect)).toBe('nav.menu, 300 × 250');
    expect(describeElement(document.querySelector('main') as Element, rect)).toBe('main, 300 × 250');
  });
});

describe('createOverlay', () => {
  test('closed shadow root: the page cannot reach the overlay', () => {
    document.body.innerHTML = html;
    const o = createOverlay(env());
    const host = document.documentElement.lastElementChild as HTMLElement;
    expect(host).not.toBe(document.body);
    expect(host.shadowRoot).toBeNull();
    expect(host.id).toBe('');
    expect(host.className).toBe('');
    o.destroy();
  });

  test('adds no page-visible globals', () => {
    document.body.innerHTML = html;
    const before = new Set(Object.getOwnPropertyNames(window));
    const o = createOverlay(env());
    expect(Object.getOwnPropertyNames(window).filter((n) => !before.has(n))).toEqual([]);
    o.destroy();
  });

  test('keyboard: arrows move the highlight, Enter picks, the page never sees the keys', () => {
    document.body.innerHTML = html;
    const e = env();
    const pageSaw = vi.fn();
    document.addEventListener('keydown', pageSaw);
    const o = createOverlay(e);
    expect(o.current()?.id).toBe('second');
    window.dispatchEvent(key('ArrowLeft'));
    expect(o.current()?.textContent).toBe('a');
    window.dispatchEvent(key('ArrowUp'));
    expect(o.current()?.className).toBe('feed');
    const enter = key('Enter');
    window.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(e.picked.map((el) => el.className)).toEqual(['feed']);
    expect(pageSaw).not.toHaveBeenCalled();
    document.removeEventListener('keydown', pageSaw);
    o.destroy();
  });

  test('announces the current element in a live region', () => {
    document.body.innerHTML = html;
    const o = createOverlay(env());
    window.dispatchEvent(key('ArrowRight'));
    expect(o.announcement()).toMatch(/^article\.card, \d+ × \d+$/);
    o.destroy();
  });

  test('pointer: hover follows the element under the pointer; a click picks it and is swallowed', () => {
    document.body.innerHTML = html;
    const target = must(document.querySelector('.menu'));
    const e = env({ elementsFromPoint: () => [last(), target] });
    const pageClick = vi.fn();
    document.addEventListener('click', pageClick);
    const o = createOverlay(e);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5 }));
    expect(o.current()).toBe(target);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(e.picked).toEqual([target]);
    expect(pageClick).not.toHaveBeenCalled();
    document.removeEventListener('click', pageClick);
    o.destroy();
  });

  test('Escape cancels; destroy removes the host and every listener', () => {
    document.body.innerHTML = html;
    const e = env();
    const o = createOverlay(e);
    window.dispatchEvent(key('Escape'));
    expect(e.cancelled).toBe(1);
    o.destroy();
    expect([...document.documentElement.children].map((c) => c.tagName)).toEqual(['HEAD', 'BODY']);
    window.dispatchEvent(key('Enter'));
    expect(e.picked).toEqual([]);
  });

  test('after a pick, hover and arrows stop until resumed; Escape still cancels', () => {
    document.body.innerHTML = html;
    const e = env();
    const o = createOverlay(e);
    window.dispatchEvent(key('Enter'));
    window.dispatchEvent(key('ArrowUp'));
    expect(o.current()?.id).toBe('second');
    window.dispatchEvent(key('Escape'));
    expect(e.cancelled).toBe(1);
    o.resume();
    window.dispatchEvent(key('ArrowUp'));
    expect(o.current()?.className).toBe('feed');
    o.destroy();
  });

  test('untrusted (script-made) events do nothing', () => {
    document.body.innerHTML = html;
    const e = env({ isTrusted: () => false });
    const o = createOverlay(e);
    window.dispatchEvent(key('ArrowUp'));
    window.dispatchEvent(key('Enter'));
    window.dispatchEvent(key('Escape'));
    expect(o.current()?.id).toBe('second');
    expect([e.picked.length, e.cancelled]).toEqual([0, 0]);
    o.destroy();
  });

  test('elements without a box are skipped; the default trust and box checks are the real ones', () => {
    document.body.innerHTML = html;
    const noBox = env({ hasBox: (el) => el.id !== 'second' });
    const o = createOverlay(noBox);
    expect(o.current()).toBe(document.body);
    o.destroy();
    const full = env();
    const plain: OverlayEnv & { picked: Element[] } = {
      document, window, elementsFromPoint: full.elementsFromPoint, onPick: full.onPick, onCancel: full.onCancel, label: full.label, hint: full.hint, picked: full.picked,
    };
    const real = createOverlay(plain);
    window.dispatchEvent(key('Enter'));
    expect(plain.picked).toEqual([]);
    real.destroy();
  });

  test('takes focus inside the closed root and gives it back on exit', () => {
    document.body.innerHTML = `${html}<button id="b">x</button>`;
    const button = document.getElementById('b') as HTMLButtonElement;
    button.focus();
    const o = createOverlay(env());
    expect(document.activeElement).not.toBe(button);
    o.resume();
    o.destroy();
    expect(document.activeElement).toBe(button);
  });

  test('standDown stops capturing the page but keeps the host (for the undo toast)', () => {
    document.body.innerHTML = html;
    const e = env();
    const o = createOverlay(e);
    o.standDown();
    window.dispatchEvent(key('Enter'));
    expect(e.picked).toEqual([]);
    expect(document.documentElement.children).toHaveLength(3);
    o.destroy();
  });

  test('mount gives the panel a place inside the closed root', () => {
    document.body.innerHTML = html;
    const o = createOverlay(env());
    const child = document.createElement('iframe');
    o.mount(child);
    expect(document.querySelector('iframe')).toBeNull();
    expect(child.isConnected).toBe(true);
    o.destroy();
  });

  describe('hint pill (D-104)', () => {
    /** The pill, reached the way the panel is: a node mounted in the closed root finds its root. */
    function pillOf(o: ReturnType<typeof createOverlay>): HTMLElement {
      const probe = document.createElement('span');
      o.mount(probe);
      const pill = (probe.getRootNode() as ShadowRoot).querySelector('[data-hint]');
      probe.remove();
      if (!(pill instanceof HTMLElement)) throw new Error('no hint pill');
      return pill;
    }
    const displayed = (pill: HTMLElement): boolean => pill.style.getPropertyValue('display') !== 'none';

    test('holds the hint as text, hidden from assistive tech, takes no pointer events, shown while choosing', () => {
      document.body.innerHTML = html;
      const o = createOverlay(env());
      const pill = pillOf(o);
      expect(pill.textContent).toBe(HINT);
      expect(pill.querySelector('b')).toBeNull();
      expect(pill.getAttribute('aria-hidden')).toBe('true');
      expect(pill.style.getPropertyValue('pointer-events')).toBe('none');
      expect(displayed(pill)).toBe(true);
      expect(document.body.textContent).not.toContain('Esc');
      o.destroy();
      expect(pill.isConnected).toBe(false);
    });

    test('a click pick hides it; resume shows it again; standDown hides it', () => {
      document.body.innerHTML = html;
      const target = must(document.querySelector('.menu'));
      const o = createOverlay(env({ elementsFromPoint: () => [last(), target] }));
      const pill = pillOf(o);
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(displayed(pill)).toBe(false);
      o.resume();
      expect(displayed(pill)).toBe(true);
      o.standDown();
      expect(displayed(pill)).toBe(false);
      o.destroy();
    });

    test('pickNow hides it; hit-testing still skips our host', () => {
      document.body.innerHTML = html;
      const target = must(document.querySelector('.menu'));
      const e = env({ elementsFromPoint: () => [last(), target] });
      const o = createOverlay(e);
      const pill = pillOf(o);
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5 }));
      expect(o.current()).toBe(target);
      expect(o.pickNow(target)).toBe(true);
      expect(displayed(pill)).toBe(false);
      expect(e.picked).toEqual([target]);
      o.destroy();
    });
  });

  describe('top layer (J15: a page popover re-shown above the picker)', () => {
    const toggle = (target: Element, newState: string): void => {
      const e = new Event('beforetoggle');
      Object.defineProperty(e, 'newState', { value: newState });
      target.dispatchEvent(e);
    };
    function popoverStubs() {
      const show = vi.fn();
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
      proto['showPopover'] = show;
      proto['hidePopover'] = vi.fn();
      return { show, restore: () => { delete proto['showPopover']; delete proto['hidePopover']; } };
    }

    test('every page popover that opens (again) after ours puts ours back on top; ours and closing ones do not', () => {
      vi.useFakeTimers();
      const { show, restore } = popoverStubs();
      try {
        document.body.innerHTML = html;
        const o = createOverlay(env());
        expect(show).toHaveBeenCalledTimes(1);
        const page = must(document.querySelector('nav'));
        toggle(page, 'open');
        vi.advanceTimersByTime(0);
        expect(show).toHaveBeenCalledTimes(2);
        toggle(page, 'closed');
        toggle(last(), 'open');
        vi.advanceTimersByTime(0);
        expect(show).toHaveBeenCalledTimes(2);
        o.destroy();
      } finally {
        restore();
        vi.useRealTimers();
      }
    });

    test('a page that keeps re-opening its popover ends the picker after MAX_PROMOTIONS; script-made toggles do not count', () => {
      vi.useFakeTimers();
      const { restore } = popoverStubs();
      try {
        document.body.innerHTML = html;
        const trusted = { value: false };
        const e = env({ isTrusted: () => trusted.value });
        const o = createOverlay(e);
        const page = must(document.querySelector('nav'));
        for (let i = 0; i < 20; i += 1) { toggle(page, 'open'); vi.advanceTimersByTime(0); }
        expect(e.cancelled).toBe(0);
        trusted.value = true;
        for (let i = 0; i < MAX_PROMOTIONS; i += 1) { toggle(page, 'open'); vi.advanceTimersByTime(0); }
        expect(e.cancelled).toBe(0);
        toggle(page, 'open');
        vi.advanceTimersByTime(0);
        expect(e.cancelled).toBe(1);
        o.destroy();
      } finally {
        restore();
        vi.useRealTimers();
      }
    });
  });
});
