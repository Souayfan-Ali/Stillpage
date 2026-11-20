import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { compileCosmetic, sanitiseProgram } from '../../../../compiler/content/cosmetic.js';
import { loadVendorLock } from '../../../../compiler/vendor/node-ports.js';
import { loadUboParser, type UboParser } from '../../../../compiler/vendor/ubo.js';
import { VENDOR_PRESENT } from './helpers.js';

const GOLDEN = new URL('../../../golden/compiler/procedural.json', import.meta.url);
const rows = (JSON.parse(readFileSync(GOLDEN, 'utf8')) as { rows: [string, string, string][] }).rows;

describe('procedural programs are sanitised where uBO\'s engine writes CSS (P1-28)', () => {
  test('selector and :style() action pass core/sanitise; the style is replaced by its sanitised form', () => {
    expect(sanitiseProgram('{"selector":"div","tasks":[["has-text","x"]]}')).toBe('{"selector":"div","tasks":[["has-text","x"]]}');
    expect(sanitiseProgram('{"selector":"div{","tasks":[]}')).toBeNull();
    expect(sanitiseProgram('{"selector":"a","tasks":[["upward",1]],"action":["style","color: red !important"]}')).toBe('{"selector":"a","tasks":[["upward",1]],"action":["style","color:red !important"]}');
    expect(sanitiseProgram('{"selector":"a","action":["style","background:url(x)"]}')).toBeNull();
    expect(sanitiseProgram('{"selector":"a","action":["remove",""]}')).toContain('remove');
  });
});

describe.skipIf(!VENDOR_PRESENT)('regression fixture: every procedural filter of the pinned lists (P1-28)', () => {
  let ubo: UboParser;
  beforeAll(async () => { ubo = await loadUboParser(await loadVendorLock()); });

  test('compiles to the recorded program', () => {
    const changed = rows.filter(([body, kind, value]) => {
      const c = compileCosmetic(body, ubo);
      return 'reason' in c ? c.reason !== kind : c.kind !== kind || c.value !== value;
    });
    expect(changed.map(([b]) => b)).toEqual([]);
  });

  test('covers every operator the plan names, including others, shadow and watch-attr', () => {
    const ops = new Set(rows.flatMap(([, , v]) => [...v.matchAll(/\["([a-z-]+)"/g)].map((m) => m[1])));
    for (const op of ['has-text', 'upward', 'remove-attr', 'others', 'xpath', 'remove-class', 'matches-css-before', 'matches-css', 'matches-attr', 'shadow', 'watch-attr', 'matches-path', 'remove', 'style']) expect(ops).toContain(op);
    expect(rows.length).toBeGreaterThanOrEqual(881);
  });
});
