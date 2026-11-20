// @vitest-environment jsdom
/**
 * P2-22b: the packaged function the toolbar panel injects with `scripting.executeScript`. It takes the
 * selector as data, only un-hides and outlines (inline, `!important`), writes nothing that stays, and
 * reverts exactly on its timer or when asked (the panel closes).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { showOnPage } from '../../../../../src/features/popup/hidden/showOnPage.js';

/** The page's host, as the panel passes it (jsdom: `localhost`). */
const H = location.hostname;
const SHOWN = ['display', 'outline-style', 'outline-width', 'outline-color', 'outline-offset'] as const;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  const make = (id: string, style?: string): HTMLElement => {
    const el = document.createElement('div');
    el.id = id;
    el.className = 'ad';
    if (style !== undefined) el.setAttribute('style', style);
    document.body.append(el);
    return el;
  };
  make('a');
  make('b', 'color: red; outline-color: blue; display: flex');
  make('c', 'display: grid !important');
});

afterEach(() => {
  showOnPage(null, 0);
  vi.useRealTimers();
});

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no #${id}`);
  return found;
}
const snapshot = (): string => document.documentElement.outerHTML;
const ownKeys = (): readonly (string | symbol)[] => Reflect.ownKeys(globalThis);

describe('showOnPage (P2-22b)', () => {
  test('un-hides and outlines every match with inline !important values, and answers the count', () => {
    expect(showOnPage('.ad', 20_000, H)).toEqual({ shown: 3 });
    for (const id of ['a', 'b', 'c']) {
      const style = el(id).style;
      expect(style.getPropertyValue('display')).toBe('revert');
      for (const name of SHOWN) expect(style.getPropertyPriority(name)).toBe('important');
      expect(style.getPropertyValue('outline-style')).toBe('solid');
    }
  });

  test('reverts exactly on the timer: the document is as it was, no attribute, no global left', () => {
    const before = snapshot();
    const keys = ownKeys();
    showOnPage('.ad', 20_000, H);
    expect(snapshot()).not.toBe(before);
    vi.advanceTimersByTime(19_999);
    expect(el('a').style.getPropertyValue('display')).toBe('revert');
    vi.advanceTimersByTime(1);
    expect(snapshot()).toBe(before);
    expect(el('a').hasAttribute('style')).toBe(false);
    expect(el('b').getAttribute('style')).toBe('color: red; outline-color: blue; display: flex');
    expect(el('c').style.getPropertyPriority('display')).toBe('important');
    expect(ownKeys()).toEqual(keys);
  });

  test('reverts when asked (selector null: the panel closed), and a second revert is harmless', () => {
    const before = snapshot();
    const keys = ownKeys();
    showOnPage('#a', 20_000, H);
    expect(showOnPage(null, 0)).toEqual({ shown: 0 });
    expect(snapshot()).toBe(before);
    expect(ownKeys()).toEqual(keys);
    expect(showOnPage(null, 0)).toEqual({ shown: 0 });
    vi.advanceTimersByTime(30_000);
    expect(snapshot()).toBe(before);
  });

  test('one preview at a time: showing another item reverts the first', () => {
    showOnPage('#a', 20_000, H);
    expect(showOnPage('#b', 20_000, H)).toEqual({ shown: 1 });
    expect(el('a').hasAttribute('style')).toBe(false);
    expect(el('b').style.getPropertyValue('display')).toBe('revert');
    vi.advanceTimersByTime(20_000);
    expect(el('b').getAttribute('style')).toBe('color: red; outline-color: blue; display: flex');
  });

  test('a style the page changed meanwhile is kept; only our properties go back', () => {
    showOnPage('#b', 20_000, H);
    el('b').style.setProperty('width', '10px');
    showOnPage(null, 0);
    const style = el('b').style;
    expect(style.getPropertyValue('width')).toBe('10px');
    expect(style.getPropertyValue('display')).toBe('flex');
    expect(style.getPropertyValue('outline-color')).toBe('blue');
    expect(style.getPropertyValue('outline-style')).toBe('');
    expect(style.getPropertyPriority('display')).toBe('');
  });

  test('a selector that matches nothing answers 0 and changes nothing', () => {
    const before = snapshot();
    expect(showOnPage('#nothing', 20_000, H)).toEqual({ shown: 0 });
    expect(snapshot()).toBe(before);
  });

  test.each([
    ['not a string', 42, 20_000],
    ['empty', '', 20_000],
    ['too long', `#${'x'.repeat(2_000)}`, 20_000],
    ['a selector the browser refuses', 'a[', 20_000],
    ['no duration', '#a', undefined],
    ['a negative duration', '#a', -1],
    ['an endless duration', '#a', 10 * 60_000],
    ['a fractional duration', '#a', 1.5],
  ])('refuses %s without touching the page', (_name, selector, ms) => {
    const before = snapshot();
    expect(showOnPage(selector, ms, H)).toEqual({ error: 'invalid' });
    expect(snapshot()).toBe(before);
  });

  test('a selector is data: markup or script text in it is never run or inserted', () => {
    const before = snapshot();
    expect(showOnPage('<img src=x onerror=alert(1)>', 20_000, H)).toEqual({ error: 'invalid' });
    expect(showOnPage('div[title="</style><script>x()</script>"]', 20_000, H)).toEqual({ shown: 0 });
    expect(snapshot()).toBe(before);
  });

  test('scrolls the first match into view when it is outside the viewport, never restores the scroll', () => {
    const scroll = vi.fn();
    el('a').scrollIntoView = scroll;
    el('a').getBoundingClientRect = () => ({ top: 5_000, bottom: 5_100, left: 0, right: 10, width: 10, height: 100, x: 0, y: 5_000, toJSON: () => ({}) });
    showOnPage('.ad', 20_000, H);
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    vi.advanceTimersByTime(20_000);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  test('does not scroll when the first match is already in view, and honours reduced motion', () => {
    const scroll = vi.fn();
    el('a').scrollIntoView = scroll;
    el('a').getBoundingClientRect = () => ({ top: 10, bottom: 50, left: 0, right: 10, width: 10, height: 40, x: 0, y: 10, toJSON: () => ({}) });
    showOnPage('#a', 20_000, H);
    expect(scroll).not.toHaveBeenCalled();
    showOnPage(null, 0);
    const media = vi.fn(() => ({ matches: true }));
    vi.stubGlobal('matchMedia', media);
    el('a').getBoundingClientRect = () => ({ top: -500, bottom: -400, left: 0, right: 10, width: 10, height: 100, x: 0, y: -500, toJSON: () => ({}) });
    showOnPage('#a', 20_000, H);
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    vi.unstubAllGlobals();
  });
  test('P2-43: refuses a page of another host (the tab navigated while the panel was open), touching nothing', () => {
    const before = snapshot();
    expect(showOnPage('.ad', 20_000, 'other.example')).toEqual({ error: 'invalid' });
    expect(showOnPage('.ad', 20_000, undefined)).toEqual({ error: 'invalid' });
    expect(snapshot()).toBe(before);
  });

  test('P2-43: a form whose inputs shadow setAttribute / getAttribute / style cannot stop the revert', () => {
    const form = document.createElement('form');
    form.className = 'ad';
    form.setAttribute('style', 'color: red');
    document.body.append(form);
    const before = snapshot();
    const keys = ownKeys();
    expect(showOnPage('.ad', 20_000, H)).toEqual({ shown: 4 });
    // jsdom lacks Chrome's [LegacyOverrideBuiltIns] named getters; own properties stand in for them.
    for (const name of ['setAttribute', 'getAttribute', 'removeAttribute', 'style']) Object.defineProperty(form, name, { value: document.createElement('input') });
    vi.advanceTimersByTime(20_000);
    expect(snapshot()).toBe(before);
    expect(ownKeys()).toEqual(keys);
  });
});
