/** P2-25: packs with generic data are flagged in the catalog; the real build's files agree with it. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadListsConfig } from '../../../../compiler/config/load.js';
import { catalogOf } from '../../../../compiler/emit/catalog.js';
import { slotsOf } from '../../../../compiler/postpass/budgets.js';
import { readCatalog } from '../../../../src/core/catalog/read.js';
import { mergeRegistrations } from '../../../../src/core/catalog/registrations.js';
import { genericDataPath } from '../../../../src/core/generic/data.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const CONFIG = path.join(ROOT, 'lists/lists.config.json');

describe('generic data in the catalog (P2-25)', () => {
  test('catalogOf flags exactly the packs given', async () => {
    const config = await loadListsConfig(CONFIG);
    const read = readCatalog(catalogOf(config, slotsOf(config), undefined, new Set(['ads', 'cookies'])));
    if (!read.ok) throw new Error(read.errors.join('; '));
    const flagged = Object.entries(read.value.packs).filter(([, p]) => p.generic).map(([id]) => id);
    expect(flagged).toEqual(['ads', 'cookies']);
    expect(read.value.genericOff).toBeNull();
  });

  const built = (f: string): string => path.join(ROOT, 'public', f);
  test.skipIf(!existsSync(built('catalog.json')) || !existsSync(built('registrations.json')))('the built catalog and registrations.json: every flagged pack ships its file; genericOff present and valid', () => {
    const catalog: unknown = JSON.parse(readFileSync(built('catalog.json'), 'utf8'));
    const registrations: unknown = JSON.parse(readFileSync(built('registrations.json'), 'utf8'));
    const read = readCatalog(mergeRegistrations(catalog, registrations));
    if (!read.ok) throw new Error(read.errors.join('; '));
    const flagged = Object.entries(read.value.packs).filter(([, p]) => p.generic).map(([id]) => id);
    expect(flagged.length).toBeGreaterThan(0);
    for (const id of flagged) expect(existsSync(built(genericDataPath(id))), id).toBe(true);
    expect(read.value.genericOff?.length).toBeGreaterThan(0);
  });
});
