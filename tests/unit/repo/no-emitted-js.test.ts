import { readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');

/** Every `.js` file under `dir` (recursive). */
function jsFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f));
}

// `tsc` given file names ignores every tsconfig (so `noEmit` too) and writes `.js` beside the sources;
// such files shadow the `.js` import specifiers for Vitest and Knip. Sources here are TypeScript only.
test('no compiled .js files sit beside the TypeScript sources', () => {
  expect([...jsFiles('src'), ...jsFiles('compiler')]).toEqual([]);
});
