import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * P1-10 / security notes §6: `chrome` (and WXT's `browser`, IndexedDB and `fetch`) are referenced only in
 * `src/platform/`. Stands in for the `no-restricted-globals` lint rule until the owner unblocks the
 * ESLint config.
 */
const SRC = path.resolve(import.meta.dirname, '../../../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Source without comments, so a doc comment that names `chrome.*` is not a finding. */
function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const rel = (file: string): string => path.relative(SRC, file);
const outsidePlatform = files(SRC).filter((f) => !rel(f).startsWith(`platform${path.sep}`));

describe('platform boundary', () => {
  test.each([
    ['chrome.', /\bchrome\s*\./],
    ['wxt/browser', /['"]wxt\/browser['"]/],
    ['indexedDB', /\bindexedDB\b/],
    ['fetch(', /\bfetch\s*\(/],
  ])('nothing outside src/platform references %s', (_name, pattern) => {
    expect(outsidePlatform.filter((f) => pattern.test(code(f))).map(rel)).toEqual([]);
  });

  test('the only fetches in src/platform are own-package reads: the catalog reader and the blocked page\'s popup-lifted.json (D-55a)', () => {
    const platform = files(path.join(SRC, 'platform')).filter((f) => /\bfetch\s*\(/.test(code(f)));
    expect(platform.map(rel)).toEqual([path.join('platform', 'blockedPage.ts'), path.join('platform', 'catalog.ts')]);
    expect(code(path.join(SRC, 'platform', 'blockedPage.ts'))).toMatch(/fetch\(browser\.runtime\.getURL\('\/popup-lifted\.json'\)\)/);
  });

  test('core imports nothing from platform, background or features', () => {
    const core = files(path.join(SRC, 'core')).filter((f) => /from\s+['"]\.\.?\/(?:\.\.\/)*(platform|background|features)\//.test(code(f)));
    expect(core.map(rel)).toEqual([]);
  });
});
