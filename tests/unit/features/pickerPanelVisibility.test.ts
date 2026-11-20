import { describe, expect, test } from 'vitest';
import { intersectionWatch, supportsVisibility, visibilityTracker, VISIBLE_FOR_MS } from '../../../src/features/picker-panel/visibility.js';

describe('picker panel clickjacking gate (J15)', () => {
  test('the tracker needs continuous visibility for VISIBLE_FOR_MS; any not-visible reading restarts it', () => {
    let t = 0;
    const tr = visibilityTracker(() => t);
    expect(tr.visible()).toBe(false);
    tr.record(true);
    t = VISIBLE_FOR_MS - 1;
    expect(tr.visible()).toBe(false);
    t = VISIBLE_FOR_MS;
    expect(tr.visible()).toBe(true);
    tr.record(false);
    expect(tr.visible()).toBe(false);
    tr.record(true);
    t += VISIBLE_FOR_MS - 1;
    expect(tr.visible()).toBe(false);
    tr.record(true);
    t += 1;
    expect(tr.visible()).toBe(true);
  });

  test('v2 support is detected from IntersectionObserverEntry.prototype.isVisible', () => {
    expect(supportsVisibility({})).toBe(false);
    expect(supportsVisibility({ IntersectionObserver: () => undefined, IntersectionObserverEntry: { prototype: {} } })).toBe(false);
    expect(supportsVisibility({ IntersectionObserver: () => undefined, IntersectionObserverEntry: { prototype: { isVisible: false } } })).toBe(true);
  });

  test('the watch observes with trackVisibility, reads the latest entry and fails closed without v2', () => {
    let t = 0;
    const observers: { cb: (e: readonly object[]) => void; options: object; targets: Element[] }[] = [];
    class FakeObserver {
      readonly targets: Element[] = [];
      constructor(readonly cb: (e: readonly object[]) => void, readonly options: object) { observers.push(this); }
      observe(el: Element): void { this.targets.push(el); }
    }
    const win = { IntersectionObserver: FakeObserver, IntersectionObserverEntry: { prototype: { isVisible: false } } } as unknown as Window & typeof globalThis;
    const changes: boolean[] = [];
    const target = {} as Element;
    const visible = intersectionWatch(win, () => t)(target, (v) => { changes.push(v); });
    expect(observers[0]?.options).toEqual({ trackVisibility: true, delay: 100, threshold: 1 });
    expect(observers[0]?.targets).toEqual([target]);
    observers[0]?.cb([{ isIntersecting: true, intersectionRatio: 1, isVisible: false }, { isIntersecting: true, intersectionRatio: 1, isVisible: true }]);
    t = VISIBLE_FOR_MS;
    expect(visible()).toBe(true);
    observers[0]?.cb([{ isIntersecting: true, intersectionRatio: 0.9, isVisible: true }]);
    expect(visible()).toBe(false);
    expect(changes).toEqual([false, true, false]);
    const none = intersectionWatch({} as Window & typeof globalThis, () => 1e9)(target);
    expect(none()).toBe(false);
  });
});
