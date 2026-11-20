// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { candidatesFor, probeFor, runPicker } from '../../../../src/content/picker/controller.js';
import { bodyOf, rootOf, safeNode } from '../../../../src/content/picker/dom.js';
import { createOverlay } from '../../../../src/content/picker/overlay.js';
import { sanitiseSelector } from '../../../../src/core/sanitise/selector.js';

const LABELS = { overlay: 'Pick an element', panel: 'The panel title', hint: 'Click to pick.' };

const query = (s: string): readonly Element[] => [...document.querySelectorAll(s)];
const env = () => ({ document, window, elementsFromPoint: () => [] as Element[], onPick: vi.fn(), onCancel: vi.fn(), label: 'Pick an element', hint: 'Click to pick.', isTrusted: () => true, hasBox: () => true });

const root = (): Element => {
  const r = rootOf(document);
  if (r === null) throw new Error('no root');
  return r;
};

afterEach(() => {
  vi.useRealTimers();
  for (const img of [...document.images]) img.remove();
  root().querySelectorAll(':scope > div').forEach((n) => { n.remove(); });
});

describe('DOM clobbering (security review MEDIUM-2)', () => {
  test('a form whose inputs shadow parentElement, id, classList and children still gives candidates, without looping', () => {
    document.body.innerHTML = '<div id="wrap"><form class="signup"><input name="parentElement"><input name="id"><input name="classList"><input name="children"><input name="tagName"></form></div>';
    const form = document.forms[0];
    if (form === undefined) throw new Error('no form');
    expect(safeNode(form).parentElement?.id).toBe('wrap');
    expect(safeNode(form).tagName).toBe('FORM');
    const c = candidatesFor(form, probeFor(form, query));
    expect(c?.candidates.map((x) => x.selector)).toContain('form.signup');
    for (const x of c?.candidates ?? []) expect(sanitiseSelector(x.selector)).toBe(x.selector);
  });

  test('named elements that shadow document built-ins do not break the overlay', () => {
    bodyOf(document)?.replaceChildren();
    for (const name of ['createElement', 'documentElement', 'body', 'activeElement']) {
      const img = new Image();
      img.setAttribute('name', name);
      bodyOf(document)?.append(img);
    }
    expect(typeof Reflect.get(document, 'createElement')).not.toBe('function');
    const o = createOverlay(env());
    expect(root().lastElementChild?.tagName).toBe('DIV');
    o.destroy();
  });

  test('the same element always gives the same view (nth-of-type needs identity)', () => {
    document.body.innerHTML = '<p>a</p><p id="x">b</p>';
    const x = document.getElementById('x') as Element;
    expect(safeNode(x)).toBe(safeNode(x));
  });
});

describe('guard', () => {
  test('the page removing our host ends the picker', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p>x</p>';
    const e = env();
    const o = createOverlay(e);
    root().lastElementChild?.remove();
    vi.advanceTimersByTime(300);
    expect(e.onCancel).toHaveBeenCalled();
    o.destroy();
  });

  test('a start-up failure ends the run cleanly: no listeners left, onEnd called once', () => {
    const add = vi.fn();
    const broken = { addEventListener: add, removeEventListener: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(),
      get innerWidth(): number { throw new Error('boom'); }, innerHeight: 0 } as unknown as Window;
    const onEnd = vi.fn();
    runPicker({ document, window: broken, query, elementsFromPoint: () => [], newSheet: () => ({ replaceSync: () => undefined }),
      panelUrl: 'chrome-extension://a/picker-panel.html', panelOrigin: 'chrome-extension://a', labels: LABELS, onEnd, setTimer: () => () => undefined }, 'abcdefghijklmnop1234');
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
    expect([...root().children].map((c) => c.tagName)).toEqual(['HEAD', 'BODY']);
  });
});
