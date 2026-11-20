/**
 * D-65 (design review, 2026-11-14): `CatalogPort.readPacks()` reads `catalog.json` without the registrations file and
 * its SHA-256 check, so it is for display answers only. The toolbar panel's `q/tabState` is the one caller;
 * everything that derives a rule, a registration or a setting keeps the checked `read()`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');

function walk(dir: string): readonly string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(rel) : [rel];
  });
}

test('only the panel answer reads the pack summary; reconcile, packs, backup, CSS fallback and settings pages read the checked catalog', () => {
  const sources = walk('src').filter((f) => /\.tsx?$/.test(f));
  const callers = sources.filter((f) => readFileSync(path.join(ROOT, f), 'utf8').includes('.readPacks('));
  expect(callers).toEqual(['src/background/panel.ts']);
  for (const file of ['reconciler', 'packs', 'backup', 'cssFallback', 'settingsPages']) {
    expect(readFileSync(path.join(ROOT, `src/background/${file}.ts`), 'utf8'), file).toMatch(/catalog\.read\(\)/);
  }
});
