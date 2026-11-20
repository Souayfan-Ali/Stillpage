// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { BOOT_EVENT, HELLO_EVENT } from '../../../src/content/popup-shim/channel.js';
import { installShim } from '../../../src/content/popup-shim/shim.js';

type Win = Window & typeof globalThis;

/** A fresh realm with a stub `open`, and (optionally) a fake sentinel that answers the hello. */
function realm(block: (url: string) => boolean, withSentinel = true) {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const w = frame.contentWindow as Win;
  const native = vi.fn((url?: string) => ({ opened: url }));
  w.open = native as unknown as Win['open'];
  const asked: string[] = [];
  if (withSentinel) {
    w.document.addEventListener(HELLO_EVENT, () => { w.document.dispatchEvent(new w.CustomEvent(BOOT_EVENT, { detail: 'sec' })); });
    w.document.addEventListener('sec', (e) => {
      const url = String((e as CustomEvent).detail);
      asked.push(url);
      if (block(url)) e.preventDefault();
    });
  }
  installShim(w);
  return { w, native, asked };
}

describe('popup-shim (P2-58)', () => {
  test('asks the sentinel; a block returns null and the native is not called', () => {
    const { w, native, asked } = realm((u) => u.includes('ad'));
    expect(w.open('https://ad.example/')).toBeNull();
    expect(w.open('https://ok.example/')).toEqual({ opened: 'https://ok.example/' });
    expect(asked).toEqual(['https://ad.example/', 'https://ok.example/']);
    expect(native).toHaveBeenCalledTimes(1);
  });

  test('one judgement per call chain: a page wrapper that calls the original is asked once', () => {
    const { w, asked } = realm(() => false);
    const original: unknown = Reflect.get(w, 'open');
    w.open = function wrapper(this: Window, ...args: unknown[]): Window | null { return Reflect.apply(original as Win['open'], this, args) as Window | null; };
    w.open('https://x.example/');
    expect(asked).toEqual(['https://x.example/']);
  });

  test('a page assignment (nowoif-style) is kept; what it opens is judged at the proxy, once, with the real URL', () => {
    const { w, asked, native } = realm((u) => u.includes('ad'));
    const original: unknown = Reflect.get(w, 'open');
    const swap = vi.fn((): Window | null => Reflect.apply(original as Win['open'], w, ['https://ad.example/']));
    w.open = swap;
    expect(w.open('https://good.example/')).toBeNull();
    expect(swap).toHaveBeenCalledTimes(1);
    expect(asked).toEqual(['https://ad.example/']);
    expect(native).not.toHaveBeenCalled();
    (w as unknown as { open: unknown }).open = undefined;
    expect(Reflect.get(w, 'open')).toBeUndefined();
  });

  test('the URL is read once, before judging: a toString cannot open unjudged or swap the URL (review HIGH-1)', () => {
    const { w, asked, native } = realm((u) => u.includes('ad'));
    let reads = 0;
    const sneaky = { toString: () => { reads += 1; if (reads === 1) w.open('https://ad.inner.example/'); return reads === 1 ? 'https://ok.example/' : 'https://ad.example/'; } };
    expect(w.open(sneaky as unknown as string)).toEqual({ opened: 'https://ok.example/' });
    expect(asked).toEqual(['https://ad.inner.example/', 'https://ok.example/']);
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith('https://ok.example/');
  });

  test('P2-43: a URL whose stringification throws once is never opened unjudged; the page gets its error', () => {
    const { w, asked, native } = realm((u) => u.includes('ad'));
    let reads = 0;
    const flaky = { toString: () => { reads += 1; if (reads === 1) throw new Error('first'); return 'https://ad.example/'; } };
    expect(() => w.open(flaky as unknown as string)).toThrow('first');
    expect(native).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  test('document.open with three arguments is a window.open and is judged (blocked: null)', () => {
    const { w, asked } = realm(() => true);
    const proxy = Reflect.get(w.Document.prototype, 'open') as (...a: unknown[]) => unknown;
    expect(Reflect.apply(proxy, w.document, ['https://ad.example/', '_blank', ''])).toBeNull();
    expect(asked).toEqual(['https://ad.example/']);
  });

  test('the boot channel closes after install: a page cannot hand the shim a secret later', () => {
    const { w, native } = realm(() => true, false);
    const forged: string[] = [];
    w.document.addEventListener('pagesecret', (e) => { forged.push(String((e as CustomEvent).detail)); e.preventDefault(); });
    w.document.dispatchEvent(new w.CustomEvent(BOOT_EVENT, { detail: 'pagesecret' }));
    expect(w.open('https://x.example/')).toEqual({ opened: 'https://x.example/' });
    expect(forged).toEqual([]);
    expect(native).toHaveBeenCalledTimes(1);
  });

  test('fails open: no sentinel, or a sentinel that throws, never blocks', () => {
    const none = realm(() => true, false);
    expect(none.w.open('https://z.example/')).toEqual({ opened: 'https://z.example/' });
    const broken = realm(() => { throw new Error('boom'); });
    expect(broken.w.open('https://z.example/')).toEqual({ opened: 'https://z.example/' });
  });

  test('a same-origin child realm is wrapped on first access through contentWindow', () => {
    const { w, asked } = realm(() => true);
    const child = w.document.createElement('iframe');
    w.document.body.append(child);
    const cw = child.contentWindow as Win;
    expect(cw.open('https://child.example/')).toBeNull();
    expect(asked).toContain('https://child.example/');
    expect(child.contentDocument?.defaultView).toBe(cw);
  });

  test('a child realm whose open is no longer our accessor (it navigated) is wrapped again on the next access', () => {
    const { w, asked } = realm(() => true);
    const child = w.document.createElement('iframe');
    w.document.body.append(child);
    const first = child.contentWindow as Win;
    Object.defineProperty(first, 'open', { configurable: true, writable: true, value: () => 'fresh native' });
    expect((child.contentWindow as Win).open('https://again.example/')).toBeNull();
    expect(asked).toContain('https://again.example/');
  });
});
