/**
 * RTL-ready layout (P2-40, UI notes §9 "RTL via logical CSS properties"): the pages' CSS never names a
 * physical side, and an arrow that means "back" or "forward" mirrors in a right-to-left locale. The
 * rendered check is `tests/e2e/i18n/pseudoLocales.spec.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');

function files(dir: string, ext: RegExp): readonly string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(`${dir}/${e.name}`, ext) : ext.test(e.name) ? [`${dir}/${e.name}`] : [],
  );
}

/** Physical sides in a declaration: `margin-left`, `left:`, `text-align: right`, `float: left`, `border-top-left-radius`. */
const PHYSICAL = /(?:^|[\s;{])(?:(?:margin|padding|border|inset)-(?:left|right)\b|(?:left|right)\s*:|text-align\s*:\s*(?:left|right)\b|float\s*:\s*(?:left|right)\b|border-(?:top|bottom)-(?:left|right)-radius)/m;
/** `margin: 0 4px 0 8px`: four values with different left and right. */
const ASYMMETRIC = /(?:margin|padding)[^\S\n]*:[^\S\n]*([^\s;:}]+)[^\S\n]+([^\s;:}]+)[^\S\n]+([^\s;:}]+)[^\S\n]+([^\s;:}]+)[^\S\n]*[;}]/g;
const ARROWS = /[←→‹›▸◂▶◀]/u;

describe('RTL-ready layout (P2-40)', () => {
  test('the checks themselves see physical sides', () => {
    for (const css of ['a { margin-left: 4px; }', '  right: 0;', 'p { text-align: left; }', 'b { border-top-right-radius: 2px }']) expect(css).toMatch(PHYSICAL);
    expect([...'a { margin: 0 4px 0 8px; }'.matchAll(ASYMMETRIC)].map((m) => m[2] !== m[4])).toEqual([true]);
    expect([...'a { padding: 1px 2px 3px 2px; margin-inline-start: 4px; }'.matchAll(ASYMMETRIC)].map((m) => m[2] !== m[4])).toEqual([false]);
  });

  test('stylesheets use logical properties only', () => {
    const found = files('src', /\.css$/).flatMap((file) => {
      const css = readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const physical = css.split('\n').filter((line) => PHYSICAL.test(line)).map((line) => `${file}: ${line.trim()}`);
      const asymmetric = [...css.matchAll(ASYMMETRIC)].filter((m) => m[2] !== m[4]).map((m) => `${file}: ${m[0]}`);
      return [...physical, ...asymmetric];
    });
    expect(found).toEqual([]);
  });

  test('direction arrows in the pages carry the mirror class', () => {
    const found = files('src', /\.tsx$/).flatMap((file) =>
      readFileSync(path.join(ROOT, file), 'utf8').split('\n').map((line, i) => ({ line, i })).filter(({ line }) => ARROWS.test(line) && !line.includes('mirror-rtl') && !/^\s*(\*|\/\/|\/\*)/.test(line))
        .map(({ line, i }) => `${file}:${String(i + 1)}: ${line.trim()}`),
    );
    expect(found).toEqual([]);
  });

  test('the mirror class flips only under dir=rtl', () => {
    const tokens = readFileSync(path.join(ROOT, 'src/ui/tokens.css'), 'utf8');
    expect(tokens).toMatch(/\[dir='rtl'\]\s+\.mirror-rtl\s*\{[^}]*transform:\s*scaleX\(-1\)/);
  });
});
