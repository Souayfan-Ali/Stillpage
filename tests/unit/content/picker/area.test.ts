// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { createAreaChain, isLarge, MAX_WIDEN } from '../../../../src/content/picker/area.js';

afterEach(() => {
  document.body.replaceChildren();
});

/** Boxes by id (jsdom has no layout); an element without an entry has the box of its first child. */
function boxes(map: Readonly<Record<string, readonly [number, number, number, number]>>) {
  const rect = (el: Element): { left: number; top: number; width: number; height: number } => {
    const found = map[el.id];
    if (found !== undefined) return { left: found[0], top: found[1], width: found[2], height: found[3] };
    const child = el.firstElementChild;
    return child === null ? { left: 0, top: 0, width: 0, height: 0 } : rect(child);
  };
  return rect;
}

describe('createAreaChain (D-81: Bigger / Smaller area)', () => {
  test('widen walks to the nearest ancestor with a different box, skipping same-box wrappers; narrow comes back exactly to the pick', () => {
    document.body.innerHTML = '<div id="outer"><div id="same"><div id="mid"><p id="pick">x</p></div></div></div>';
    const rect = boxes({ pick: [0, 0, 10, 10], mid: [0, 0, 50, 50], outer: [0, 0, 100, 100] });
    const pick = document.getElementById('pick') as Element;
    const chain = createAreaChain(pick, { rect });
    expect([chain.canWiden(), chain.canNarrow()]).toEqual([true, false]);
    expect(chain.widen()).toBe(true);
    expect(chain.at().id).toBe('mid');
    expect(chain.widen()).toBe(true);
    expect(chain.at().id).toBe('outer');
    expect(chain.canWiden()).toBe(false);
    expect(chain.widen()).toBe(false);
    expect(chain.at().id).toBe('outer');
    expect(chain.narrow()).toBe(true);
    expect(chain.at().id).toBe('mid');
    expect(chain.narrow()).toBe(true);
    expect(chain.at()).toBe(pick);
    expect(chain.narrow()).toBe(false);
    expect(chain.at()).toBe(pick);
  });

  test('never body or html', () => {
    document.body.innerHTML = '<p id="pick">x</p>';
    const chain = createAreaChain(document.getElementById('pick') as Element, { rect: boxes({ pick: [0, 0, 10, 10] }) });
    expect(chain.canWiden()).toBe(false);
    expect(chain.widen()).toBe(false);
  });

  test('at most MAX_WIDEN steps above the pick', () => {
    const depth = MAX_WIDEN + 5;
    document.body.innerHTML = `${'<div>'.repeat(depth)}<p id="pick">x</p>${'</div>'.repeat(depth)}`;
    const pick = document.getElementById('pick') as Element;
    let size = 10;
    const sizes = new Map<Element, number>();
    for (let el = pick as Element | null; el !== null && el !== document.body; el = el.parentElement) {
      sizes.set(el, size);
      size += 10;
    }
    const chain = createAreaChain(pick, { rect: (el) => ({ left: 0, top: 0, width: sizes.get(el) ?? 0, height: 10 }) });
    let steps = 0;
    while (chain.widen()) steps += 1;
    expect(steps).toBe(MAX_WIDEN);
    expect(chain.canWiden()).toBe(false);
  });

  test('ancestors without a box are skipped', () => {
    document.body.innerHTML = '<div id="outer"><div id="hollow"><p id="pick">x</p></div></div>';
    const rect = (el: Element) => (el.id === 'hollow' ? { left: 0, top: 0, width: 0, height: 0 } : el.id === 'pick' ? { left: 0, top: 0, width: 5, height: 5 } : { left: 0, top: 0, width: 50, height: 50 });
    const chain = createAreaChain(document.getElementById('pick') as Element, { rect });
    expect(chain.widen()).toBe(true);
    expect(chain.at().id).toBe('outer');
  });
});

describe('isLarge: the visible box covers half the viewport or more', () => {
  test.each([
    [{ left: 0, top: 0, width: 800, height: 300 }, true],
    [{ left: 0, top: 0, width: 400, height: 500 }, false],
    [{ left: -2000, top: 0, width: 2300, height: 600 }, false],
    [{ left: 0, top: -100, width: 800, height: 5000 }, true],
  ])('%j → %s', (box, large) => {
    expect(isLarge(box, { width: 800, height: 600 })).toBe(large);
  });
});
