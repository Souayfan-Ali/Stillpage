/**
 * Build-artefact test (P2-44): every shipped JS file is under a size budget of its own, not only the
 * "all shipped JS" total. P2-40 added a shared chunk that no line covered; a new entrypoint or chunk
 * now fails here until `.size-limit.json` names it.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { BUILD_DIR } from './helpers/fixtureExtension.js';

const ROOT = path.join(import.meta.dirname, '../..');
/** The total over every file: it covers everything, so it cannot show a file without a budget. */
const TOTAL = 'all shipped JS, minified, excluding generated data (performance notes §2.1)';
/** Budgeted outside size-limit: the sentinel's byte gate is `manifest.spec.ts` (ADR-018: ≤ 5,000 B gzip, raw line beside it). */
const GATED_ELSEWHERE = new Set(['popup-sentinel.js']);

interface SizeEntry {
  readonly name: string;
  readonly path: string | readonly string[];
}

function covers(entry: SizeEntry, file: string): boolean {
  const globs = typeof entry.path === 'string' ? [entry.path] : entry.path;
  const included = globs.filter((g) => !g.startsWith('!')).some((g) => path.matchesGlob(file, g));
  const excluded = globs.filter((g) => g.startsWith('!')).some((g) => path.matchesGlob(file, g.slice(1)));
  return included && !excluded;
}

test('every shipped JS file is under a size-limit line of its own', async () => {
  const entries = JSON.parse(await readFile(path.join(ROOT, '.size-limit.json'), 'utf8')) as readonly SizeEntry[];
  expect(entries.some((e) => e.name === TOTAL), 'the total line was renamed; update this test').toBe(true);
  const own = entries.filter((e) => e.name !== TOTAL);
  const shipped = (await readdir(BUILD_DIR, { recursive: true })).filter((f) => f.endsWith('.js') && !GATED_ELSEWHERE.has(f));
  const outputDir = path.relative(ROOT, BUILD_DIR);
  const uncovered = shipped.filter((f) => !own.some((e) => covers(e, path.join(outputDir, f))));
  expect(uncovered).toEqual([]);
});
