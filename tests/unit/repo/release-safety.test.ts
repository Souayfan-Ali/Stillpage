/**
 * Release safety (D-33): the packed-install test harness (`tests/e2e/helpers/packed.ts`, which forges Chromium's
 * preference MAC in throwaway profiles) and every other test helper must never reach what ships: the extension
 * sources, the compiler and release tooling, `scripts/`, the build output and its zip.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { readZip } from '../../../compiler/release/zip.js';
import { THROWAWAY_MARKER } from '../../e2e/helpers/throwawayProfile.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
/** Strings only the test harness contains. */
const HARNESS_MARKERS = ['installPacked', 'prefMac', 'assertThrowawayProfile', THROWAWAY_MARKER];
const IMPORTS_TESTS = /from\s+['"][^'"]*\btests\//;
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|html|css|sh)$/;

function files(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [dir];
  return readdirSync(abs, { recursive: true, encoding: 'utf8' }).map((f) => path.join(dir, f)).filter((f) => TEXT.test(f) && statSync(path.join(ROOT, f)).isFile());
}

const offending = (name: string, text: string): string[] => [
  ...(IMPORTS_TESTS.test(text) ? [`${name}: imports from tests/`] : []),
  ...HARNESS_MARKERS.filter((m) => text.includes(m)).map((m) => `${name}: contains ${m}`),
];

describe('test-only harness never ships (D-33)', () => {
  test('sources, tooling and scripts neither import tests/ nor contain the harness', () => {
    const shipped = ['src', 'compiler', 'scripts', 'wxt.config.ts'].flatMap(files);
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.flatMap((f) => offending(f, readFileSync(path.join(ROOT, f), 'utf8')))).toEqual([]);
  });

  test('the built extension and its zip (when built) contain no harness code', () => {
    const built = files('.output/chrome-mv3').flatMap((f) => offending(f, readFileSync(path.join(ROOT, f), 'utf8')));
    const zips = existsSync(path.join(ROOT, '.output')) ? readdirSync(path.join(ROOT, '.output')).filter((f) => f.endsWith('.zip')) : [];
    const zipped = zips.flatMap((z) => readZip(readFileSync(path.join(ROOT, '.output', z)))
      .filter((e) => TEXT.test(e.path)).flatMap((e) => offending(`${z}:${e.path}`, new TextDecoder().decode(e.data))));
    expect([...built, ...zipped]).toEqual([]);
  });

  test('the check bites', () => {
    expect(offending('x.ts', "import { installPacked } from '../tests/e2e/helpers/packed.js';")).toHaveLength(2);
  });
});
