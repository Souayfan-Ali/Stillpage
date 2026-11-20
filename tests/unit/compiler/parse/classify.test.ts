import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { classify, LINE_KINDS, type LineKind } from '../../../../compiler/parse/classify.js';

const GOLDEN = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../golden/compiler/classify.json'), 'utf8'),
) as Partial<Record<LineKind, string[]>>;

describe('classify (golden, one block per class)', () => {
  test('the golden file has at least one case for every class', () => {
    for (const kind of LINE_KINDS) expect(GOLDEN[kind]?.length ?? 0, kind).toBeGreaterThan(0);
  });

  for (const kind of LINE_KINDS) {
    test.each(GOLDEN[kind] ?? [])(`${kind}: %s`, (text) => {
      expect(classify(text).kind).toBe(kind);
    });
  }

  test('S-02c regression: an exception with only domain= is a network rule, not a cosmetic switch', () => {
    const c = classify('@@||cdn.example^$domain=site.example');
    expect(c.kind).toBe('network');
    expect(c.node?.category).toBe('Network');
  });

  test('invalid lines carry the parser message', () => {
    expect(classify('example.com##').detail).toMatch(/./);
  });

  test('unsupported syntax names the reason', () => {
    expect(classify('site.example#$#abort-on-property-read x').detail).toBe('scriptlet syntax AdblockPlus');
  });
});
