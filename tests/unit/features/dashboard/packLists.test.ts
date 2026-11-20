import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { LISTS, PACK_LISTS } from '../../../../src/features/dashboard/packLists.js';

interface Config {
  lists: { id: string; title: string; licence: string; homepage: string }[];
  rulesets: { id: string; pack: string; lists?: string[] }[];
  popups: { pack: string; from: string[] };
}

const config = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../../lists/lists.config.json'), 'utf8')) as Config;
const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

describe('pack lists projection (P2-34)', () => {
  test('lists equal lists.config.json (id, title, licence, homepage)', () => {
    const expected = Object.fromEntries(config.lists.map((l) => [l.id, { title: l.title, licence: l.licence, homepage: l.homepage }]));
    expect(LISTS).toEqual(expected);
  });

  test('pack → lists equals the config; popups takes the lists of its source rulesets', () => {
    const packs = unique(config.rulesets.map((r) => r.pack));
    const expected = Object.fromEntries(packs.map((p) => [p, unique(config.rulesets.filter((r) => r.pack === p).flatMap((r) => r.lists ?? []))]));
    const fromRulesets = unique(config.popups.from.flatMap((id) => config.rulesets.find((r) => r.id === id)?.lists ?? []));
    expect(PACK_LISTS).toEqual({ ...expected, [config.popups.pack]: fromRulesets });
  });

  test('every homepage is https', () => {
    expect(Object.values(LISTS).every((l) => l.homepage.startsWith('https://'))).toBe(true);
  });
});
