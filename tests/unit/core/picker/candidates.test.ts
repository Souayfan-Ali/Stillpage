// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { generateCandidates } from '../../../../src/core/picker/candidates.js';
import { rankCandidates, type Probe } from '../../../../src/core/picker/rank.js';
import { sanitiseSelector } from '../../../../src/core/sanitise/selector.js';

/** Fixture DOM in jsdom; the probe is what the picker content script does with `querySelectorAll`. */
function setup(html: string): { readonly target: Element; readonly probe: Probe } {
  document.body.innerHTML = html;
  const target = document.querySelector('[data-target]');
  if (target === null) throw new Error('fixture has no [data-target]');
  target.removeAttribute('data-target');
  const probe: Probe = (selector) => {
    try {
      const found = [...document.querySelectorAll(selector)];
      return { count: found.length, includesTarget: found.includes(target) };
    } catch {
      return null;
    }
  };
  return { target, probe };
}

const selectorsOf = (html: string): readonly string[] => {
  const { target, probe } = setup(html);
  return rankCandidates(generateCandidates(target), probe).map((c) => c.selector);
};

describe('generateCandidates on fixture DOMs', () => {
  test('a stable id is the first candidate', () => {
    const out = selectorsOf('<div id="main"><aside id="promo-box" class="box" data-target></aside></div>');
    expect(out[0]).toBe('#promo-box');
  });

  test('a hashed id is penalised below a stable class', () => {
    const out = selectorsOf('<div><aside id="a8f3c2d1" class="newsletter" data-target></aside></div>');
    expect(out.indexOf('aside.newsletter')).toBeLessThan(out.indexOf('#a8f3c2d1'));
  });

  test('hashed classes rank below stable ones and are left out of the combined class candidate', () => {
    const out = selectorsOf('<section class="sidebar"><div class="ad-slot css-1x2y3z" data-target></div></section>');
    expect(out[0]).toBe('div.ad-slot');
    expect(out).not.toContain('div.ad-slot.css-1x2y3z');
    expect(out.indexOf('.css-1x2y3z')).toBeGreaterThan(out.indexOf('.ad-slot'));
  });

  test('attribute anchors: data-* and aria-label, quoted', () => {
    const out = selectorsOf('<div><button aria-label="Close ad" data-ad-unit="top" data-target>x</button></div>');
    expect(out).toContain('button[aria-label="Close ad"]');
    expect(out).toContain('button[data-ad-unit="top"]');
  });

  test('links and frames are anchored by the start of their address', () => {
    const link = selectorsOf('<p><a href="https://ads.example.net/click?id=9" data-target>buy</a></p>');
    expect(link).toContain('a[href^="https://ads.example.net/"]');
    const frame = selectorsOf('<p><iframe src="https://ads.example.net/frame.html" data-target></iframe></p>');
    expect(frame).toContain('iframe[src^="https://ads.example.net/"]');
  });

  test('nested element without anchors gets a structural path from the nearest id', () => {
    const out = selectorsOf('<div id="feed"><div><span></span><span data-target>x</span></div></div>');
    expect(out).toContain('#feed > div > span:nth-of-type(2)');
  });

  test('without any id the structural path starts at body', () => {
    const out = selectorsOf('<div><div></div><div><b data-target>x</b></div></div>');
    expect(out).toContain('body > div > div:nth-of-type(2) > b');
  });

  test('a stable class on an ancestor gives a wider candidate', () => {
    const out = selectorsOf('<ul class="results"><li class="card">a</li><li class="card" data-target>b</li></ul>');
    expect(out).toContain('.results .card');
  });

  test('long lists: a class shared by many items matches all of them', () => {
    const items = Array.from({ length: 50 }, (_, i) => `<li class="row"${i === 30 ? ' data-target' : ''}>${String(i)}</li>`).join('');
    const { target, probe } = setup(`<ul>${items}</ul>`);
    const ranked = rankCandidates(generateCandidates(target), probe);
    expect(ranked.find((c) => c.selector === 'li.row')?.count).toBe(50);
    expect(ranked.some((c) => c.count === 1)).toBe(true);
  });

  test('classes needing a digit escape or unsafe characters are skipped', () => {
    const out = selectorsOf('<div><p class="1col x{y ok" data-target>t</p></div>');
    expect(out.join(' ')).not.toMatch(/1col|x\{y/);
    expect(out).toContain('p.ok');
  });

  test('tailwind-style punctuation is escaped', () => {
    const out = selectorsOf('<div><p class="md:flex" data-target>t</p></div>');
    expect(out).toContain('p.md\\:flex');
  });
});

describe('rankCandidates', () => {
  test('every output passes the sanitiser, matches the target, and is unique', () => {
    const fixtures = [
      '<div id="x"><span class="a b c" title="t" data-target>1</span></div>',
      '<main><article class="post"><div class="Button_root__a1B2c" role="banner" data-target></div></article></main>',
      '<div><img src="https://cdn.example/x.png" alt="Sponsored" data-target></div>',
      '<table><tr><td></td><td data-target>2</td></tr></table>',
    ];
    for (const html of fixtures) {
      const { target, probe } = setup(html);
      const ranked = rankCandidates(generateCandidates(target), probe);
      expect(ranked.length).toBeGreaterThan(0);
      expect(new Set(ranked.map((c) => c.selector)).size).toBe(ranked.length);
      for (const c of ranked) {
        expect(sanitiseSelector(c.selector)).toBe(c.selector);
        expect(probe(c.selector)?.includesTarget).toBe(true);
      }
    }
  });

  test('drops candidates the document refuses or that miss the target', () => {
    const { target } = setup('<div class="a" data-target></div>');
    const probe: Probe = (s) => (s === 'div.a' ? { count: 1, includesTarget: true } : s === '.a' ? null : { count: 3, includesTarget: false });
    expect(rankCandidates(generateCandidates(target), probe).map((c) => c.selector)).toEqual(['div.a']);
  });

  test('ranked best first; ties broken by narrower, then shorter', () => {
    const { target, probe } = setup('<div class="a"><p class="b" data-target></p><p class="b"></p></div>');
    const ranked = rankCandidates(generateCandidates(target), probe);
    for (let i = 1; i < ranked.length; i += 1) expect((ranked[i - 1]?.score ?? 0) >= (ranked[i]?.score ?? 0)).toBe(true);
  });

  test('bySpread orders narrow to wide for the slider', async () => {
    const { bySpread } = await import('../../../../src/core/picker/rank.js');
    const { target, probe } = setup('<ul class="r"><li class="c">a</li><li class="c" data-target>b</li></ul>');
    const counts = bySpread(rankCandidates(generateCandidates(target), probe)).map((c) => c.count);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  test('a candidate the generator built over the length cap is never returned', () => {
    const { target, probe } = setup(`<div><p class="${'k'.repeat(190)}" title="${'t'.repeat(190)}" data-target></p></div>`);
    for (const c of rankCandidates(generateCandidates(target), probe)) expect(c.selector.length).toBeLessThanOrEqual(1_024);
  });
});
