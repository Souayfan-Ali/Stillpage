// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import type { ViewActions, ViewModel } from '../../../src/features/picker-panel/panel.js';
import { COVERED, renderPanel, renderToast, showPanelError, TOAST_MS } from '../../../src/features/picker-panel/view.js';
import type { VisibilityWatch } from '../../../src/features/picker-panel/visibility.js';
import { axeViolations } from '../ui/axe.js';

const MODEL: ViewModel = {
  candidates: [{ selector: '#t', count: 1 }, { selector: 'li.row', count: 12 }, { selector: '<img src=x onerror=alert(1)>', count: 3 }],
  index: 0, hostname: 'news.example.com', mode: 'hide', canWiden: true, canNarrow: false, large: false,
};

/** Every button visible (the panel is not covered); `covered` reports them hidden by the page. */
const shown: VisibilityWatch = (_el, onChange) => { onChange?.(true); return () => true; };
const covered: VisibilityWatch = (_el, onChange) => { onChange?.(false); return () => false; };

function setup(model = MODEL, watch = shown) {
  document.body.replaceChildren();
  const actions = { select: vi.fn(), hideOnce: vi.fn(), hideAlways: vi.fn(() => Promise.resolve()), cancel: vi.fn(), widen: vi.fn(), narrow: vi.fn() } satisfies ViewActions;
  const refresh = renderPanel(document, model, actions, watch);
  const q = (sel: string): HTMLElement => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLElement)) throw new Error(`missing ${sel}`);
    return el;
  };
  const qi = (sel: string): HTMLInputElement => {
    const el = q(sel);
    if (!(el instanceof HTMLInputElement)) throw new Error(`not an input: ${sel}`);
    return el;
  };
  return { actions, q, qi, refresh };
}

describe('renderPanel', () => {
  test('a dialog with the count, the slider at the best candidate, "always" preselected, preview on', () => {
    const { actions, q, qi } = setup();
    expect(q('[role="dialog"]').getAttribute('aria-labelledby')).toBe(q('h1').id);
    expect(q('[data-count]').textContent).toBe('Hides 1 item on this page');
    const slider = qi('input[type="range"]');
    expect([slider.min, slider.max, slider.value]).toEqual(['0', '2', '0']);
    expect(qi('input[value="always"]').checked).toBe(true);
    expect(q('label[for="always"]').textContent).toBe('Hide always on news.example.com');
    expect(qi('input[type="checkbox"]').checked).toBe(true);
    expect(actions.select).toHaveBeenCalledWith(0, true);
    expect(document.activeElement).toBe(slider);
  });

  test('"zap" mode preselects "once"', () => {
    const { qi } = setup({ ...MODEL, mode: 'zap' });
    expect(qi('input[value="once"]').checked).toBe(true);
  });

  test('the slider updates count, selector and preview; the preview checkbox turns preview off', () => {
    const { actions, q, qi } = setup();
    const slider = qi('input[type="range"]');
    slider.value = '1';
    slider.dispatchEvent(new Event('input'));
    expect(q('[data-count]').textContent).toBe('Hides 12 items on this page');
    expect(slider.getAttribute('aria-valuetext')).toBe('12 items');
    expect(q('code').textContent).toBe('li.row');
    expect(actions.select).toHaveBeenLastCalledWith(1, true);
    const preview = qi('input[type="checkbox"]');
    preview.checked = false;
    preview.dispatchEvent(new Event('change'));
    expect(actions.select).toHaveBeenLastCalledWith(1, false);
  });

  test('page-derived selector text is rendered as text, never markup', () => {
    const { q } = setup({ ...MODEL, index: 2 });
    expect(q('code').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });

  test('Hide follows the chosen option; Cancel and Escape cancel', () => {
    const { actions, q, qi } = setup();
    q('button[data-hide]').click();
    expect(actions.hideAlways).toHaveBeenCalledWith(0);
    qi('input[value="once"]').click();
    q('button[data-hide]').click();
    expect(actions.hideOnce).toHaveBeenCalledWith(0);
    q('button[data-cancel]').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(actions.cancel).toHaveBeenCalledTimes(2);
  });

  test('covered by the page (J15 clickjacking): Hide does nothing in either mode and says why; Cancel still works', () => {
    const { actions, q, qi } = setup(MODEL, covered);
    expect(q('button[data-hide]').getAttribute('aria-disabled')).toBe('true');
    q('button[data-hide]').click();
    qi('input[value="once"]').click();
    q('button[data-hide]').click();
    expect(actions.hideAlways).not.toHaveBeenCalled();
    expect(actions.hideOnce).not.toHaveBeenCalled();
    expect(q('[data-covered]').textContent).toBe(COVERED);
    q('button[data-cancel]').click();
    expect(actions.cancel).toHaveBeenCalledTimes(1);
  });

  test('focus is trapped inside the dialog (D-81: the Area buttons come first)', () => {
    const { q } = setup();
    const cancel = q('button[data-cancel]');
    const hide = q('button[data-hide]');
    const wider = q('button[data-widen]');
    const last = [...document.querySelectorAll<HTMLElement>('button, input, summary')].at(-1) ?? hide;
    last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(wider);
    wider.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
    cancel.focus();
    const mid = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(mid);
    expect(mid.defaultPrevented).toBe(false);
  });

  test('D-81: Area buttons come before the slider; at a limit aria-disabled (not disabled) and inert; the limit line', () => {
    const { actions, q } = setup();
    const group = q('[role="group"]');
    expect(group.getAttribute('aria-labelledby')).toBe('area-label');
    expect(q('#area-label').textContent).toBe('Area');
    const wider = q('button[data-widen]');
    const narrower = q('button[data-narrow]');
    expect([wider.textContent, narrower.textContent]).toEqual(['Bigger area', 'Smaller area']);
    const order = [...document.querySelectorAll('button, input')];
    expect(order.indexOf(wider)).toBeLessThan(order.indexOf(q('input[type="range"]')));
    expect([wider.getAttribute('aria-disabled'), narrower.getAttribute('aria-disabled')]).toEqual(['false', 'true']);
    expect(narrower.hasAttribute('disabled')).toBe(false);
    narrower.click();
    expect(actions.narrow).not.toHaveBeenCalled();
    wider.click();
    expect(actions.widen).toHaveBeenCalledTimes(1);
    expect(q('[data-area]').getAttribute('role')).toBe('status');
    expect(q('[data-area]').textContent).toBe('');
  });

  test('D-81: a new offer updates the dialog in place: focus stays on the pressed button; count, selector, preview, warning', () => {
    const { actions, q, qi, refresh } = setup();
    const wider = q('button[data-widen]');
    wider.focus();
    refresh({ ...MODEL, candidates: [{ selector: '#wrap', count: 1 }, { selector: 'div.box', count: 4 }], index: 1, canWiden: false, canNarrow: true, large: true });
    expect(document.activeElement).toBe(wider);
    expect(q('button[data-widen]')).toBe(wider);
    const slider = qi('input[type="range"]');
    expect([slider.max, slider.value]).toEqual(['1', '1']);
    expect(q('[data-count]').textContent).toBe('Hides 4 items on this page');
    expect(q('code').textContent).toBe('div.box');
    expect(actions.select).toHaveBeenLastCalledWith(1, true);
    expect(q('[data-area]').textContent).toBe('This is a large part of the page. This is the biggest area you can pick.');
    expect([wider.getAttribute('aria-disabled'), q('button[data-narrow]').getAttribute('aria-disabled')]).toEqual(['true', 'false']);
  });

  test('D-105 wording: title, slider and its ends, preview, selector; the low end says "only this" only when true', () => {
    const { q, qi, refresh } = setup();
    expect(q('h1').textContent).toBe('Hide this?');
    const slider = qi('input[type="range"]');
    expect(q('label[for="spread"]').textContent).toBe('Similar ones too?');
    const ends = (): (string | null)[] => [slider.previousElementSibling?.textContent ?? null, slider.nextElementSibling?.textContent ?? null];
    expect(ends()).toEqual(['only this', 'more like it']);
    expect(slider.getAttribute('aria-valuetext')).toBe('1 item');
    expect(q('label[for="preview"]').textContent).toBe('Show the page without it');
    expect(q('summary').textContent).toBe('Advanced: selector');
    // Bigger / Smaller area replaces the candidates in place: the narrowest now hides two items.
    refresh({ ...MODEL, candidates: [{ selector: '.ad', count: 2 }, { selector: 'div', count: 9 }], index: 0 });
    expect(ends()).toEqual(['fewer', 'more like it']);
    refresh(MODEL);
    expect(ends()).toEqual(['only this', 'more like it']);
  });

  test('D-105: the dialog keeps its order (title, count, area, slider, preview, how long, lines, buttons, selector)', () => {
    const { q } = setup();
    const order = [...q('[role="dialog"]').children].map((c) => {
      if (c.matches('[role="group"]')) return 'area';
      const marks = ['data-count', 'data-area', 'data-error', 'data-covered'].filter((a) => c.hasAttribute(a));
      if (marks.length > 0) return marks[0];
      if (c.querySelector('#spread')) return 'slider';
      if (c.querySelector('#preview')) return 'preview';
      return c.tagName.toLowerCase();
    });
    expect(order).toEqual(['h1', 'data-count', 'area', 'data-area', 'slider', 'preview', 'fieldset', 'data-error', 'data-covered', 'div', 'details']);
    expect(q('.buttons').textContent).toBe('CancelHide');
    expect([...document.querySelectorAll('button, input, summary')].map((e) => e.getAttribute('data-widen') !== null ? 'bigger' : e.getAttribute('data-narrow') !== null ? 'smaller'
      : e.id !== '' ? e.id : e.getAttribute('data-cancel') !== null ? 'cancel' : e.getAttribute('data-hide') !== null ? 'hide' : e.tagName.toLowerCase()))
      .toEqual(['bigger', 'smaller', 'spread', 'preview', 'once', 'always', 'cancel', 'hide', 'summary']);
  });

  test('D-110: the slider row is a block: label, low end, slider, high end, in that order', () => {
    const { q } = setup();
    const row = q('#spread').parentElement;
    if (row === null) throw new Error('no slider row');
    expect([...row.classList]).toEqual(['row', 'slider']);
    const children = [...row.children];
    expect(children).toHaveLength(4);
    expect(children[0]?.matches('label[for="spread"]')).toBe(true);
    expect(children[1]?.matches('span[aria-hidden="true"]')).toBe(true);
    expect(children[2]?.matches('input#spread')).toBe(true);
    expect(children[3]?.matches('span[aria-hidden="true"]')).toBe(true);
  });

  test('errors are announced', () => {
    setup();
    showPanelError(document, 'Could not save');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Could not save');
  });

  test('axe: no violations, with and without the area warning', async () => {
    const { refresh } = setup();
    expect(await axeViolations(document.body)).toEqual([]);
    refresh({ ...MODEL, canWiden: false, canNarrow: true, large: true });
    expect(await axeViolations(document.body)).toEqual([]);
  });

  test('toast: "Hidden. Undo", focused, times out unless hovered or focused; Undo calls back once at a time', async () => {
    document.body.replaceChildren();
    const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
    const setTimer = (run: () => void, ms: number) => {
      const t = { run, ms, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    };
    let release: () => void = () => undefined;
    const actions = { undo: vi.fn(() => new Promise<void>((r) => { release = r; })), expire: vi.fn() };
    renderToast(document, actions, setTimer, shown);
    const undo = document.querySelector('button');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Hidden.');
    expect(document.activeElement).toBe(undo);
    expect(timers[0]?.ms).toBe(TOAST_MS);
    const box = document.querySelector('.toast');
    box?.dispatchEvent(new Event('mouseenter'));
    expect(timers[0]?.cancelled).toBe(true);
    undo?.blur();
    box?.dispatchEvent(new Event('mouseleave'));
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(1);
    undo?.click();
    expect(actions.undo).toHaveBeenCalledTimes(1);
    expect(undo?.disabled).toBe(true);
    release();
    await vi.waitFor(() => { expect(undo?.disabled).toBe(false); });
    timers.at(-1)?.run();
    expect(actions.expire).toHaveBeenCalledTimes(1);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  test('toast covered by the page: Undo does nothing and says why', () => {
    document.body.replaceChildren();
    const actions = { undo: vi.fn(() => Promise.resolve()), expire: vi.fn() };
    renderToast(document, actions, () => () => undefined, covered);
    const undo = document.querySelector('button');
    expect(undo?.getAttribute('aria-disabled')).toBe('true');
    undo?.click();
    expect(actions.undo).not.toHaveBeenCalled();
    expect(document.querySelector('[data-covered]')?.textContent).toBe(COVERED);
  });
});
