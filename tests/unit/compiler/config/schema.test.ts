import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadListsConfig, loadLock, parseJsonWith } from '../../../../compiler/config/load.js';
import { isGitList, ListsConfigSchema } from '../../../../compiler/config/schema.js';
import { EMPTY_LOCK } from '../../../../compiler/fetch/lock.js';

const CONFIG_FILE = path.resolve(import.meta.dirname, '../../../../lists/lists.config.json');
const read = (): Record<string, unknown> => JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
const errorsOf = (value: unknown): string[] => {
  const r = ListsConfigSchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('lists.config.json', () => {
  test('the committed config is valid and every ruleset has lists except our own GPC rule (P2-27…P2-31)', async () => {
    const config = await loadListsConfig(CONFIG_FILE);
    expect(config.rulesets.filter((r) => r.lists.length === 0).map((r) => r.id)).toEqual(['gpc']);
    expect(config.lists.filter((l) => l.licenceState === 'owner-pending').map((l) => l.id)).toEqual(['easylist-china', 'easylist-spanish', 'easylist-portuguese']);
  });

  test('every list carries a licence state and a trust flag; only uAssets lists are trusted (S-03)', async () => {
    const config = await loadListsConfig(CONFIG_FILE);
    for (const list of config.lists) {
      expect(['cleared', 'owner-pending']).toContain(list.licenceState);
      const isUbo = isGitList(list) && list.path.startsWith('filters/');
      expect(list.trusted).toBe(isUbo);
    }
  });

  test('rejects a list without a trust flag or with an unknown licence state', () => {
    const raw = read();
    const lists = raw['lists'] as Record<string, unknown>[];
    const [first, ...others] = lists;
    const untrusted = Object.fromEntries(Object.entries(first ?? {}).filter(([k]) => k !== 'trusted'));
    expect(errorsOf({ ...raw, lists: [untrusted, ...others] }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...raw, lists: [{ ...first, licenceState: 'maybe' }, ...others] }).length).toBeGreaterThan(0);
  });

  test('reports broken references: unknown list, list in two rulesets, orphan list, unknown source', () => {
    const raw = read();
    const rulesets = raw['rulesets'] as { lists: string[] }[];
    const lists = raw['lists'] as Record<string, unknown>[];
    const withUnknown = { ...raw, rulesets: [{ ...rulesets[0], lists: ['nope'] }, ...rulesets.slice(1)] };
    expect(errorsOf(withUnknown)).toEqual(expect.arrayContaining(['ruleset references unknown list "nope"']));
    const twice = { ...raw, rulesets: [...rulesets, { id: 'again', pack: 'ads', category: 'ads', lists: ['easylist'], slots: { safe: { rules: 1, regex: 0 } } }] };
    expect(errorsOf(twice)).toContain('list "easylist" is in more than one ruleset');
    const badSource = { ...raw, lists: [{ ...lists[0], source: 'elsewhere' }, ...lists.slice(1)] };
    expect(errorsOf(badSource).some((m) => m.includes('unknown source "elsewhere"'))).toBe(true);
    const dup = { ...raw, lists: [...lists, lists[0]] };
    expect(errorsOf(dup).some((m) => m.startsWith('duplicate list id'))).toBe(true);
  });

  test('rejects plain http URLs and invalid ruleset ids', () => {
    const raw = read();
    const lists = raw['lists'] as Record<string, unknown>[];
    const httpList = { ...raw, lists: lists.map((l) => (l['id'] === 'urlhaus' ? { ...l, url: 'http://x.example/h.txt' } : l)) };
    expect(errorsOf(httpList).length).toBeGreaterThan(0);
    const rulesets = raw['rulesets'] as Record<string, unknown>[];
    expect(errorsOf({ ...raw, rulesets: [{ ...rulesets[0], id: '_Bad' }, ...rulesets.slice(1)] })).toContain('invalid ruleset id');
  });
});

describe('packs, slots and popups (P1-25)', () => {
  test('reports unknown and unused packs, a slot-less ruleset, a -x id and a bad popups source', () => {
    const raw = read();
    const rulesets = raw['rulesets'] as Record<string, unknown>[];
    const packs = raw['packs'] as Record<string, unknown>;
    expect(errorsOf({ ...raw, rulesets: [{ ...rulesets[0], pack: 'nope' }, ...rulesets.slice(1)] })).toContain('unknown pack "nope"');
    expect(errorsOf({ ...raw, packs: { ...packs, spare: { title: 'S', default: false } } })).toContain('pack "spare" has no ruleset');
    expect(errorsOf({ ...raw, rulesets: [{ ...rulesets[0], slots: {} }, ...rulesets.slice(1)] })).toContain('a ruleset needs at least one slot');
    expect(errorsOf({ ...raw, rulesets: [{ ...rulesets[0], id: 'ubo-x' }, ...rulesets.slice(1)] })).toContain('invalid ruleset id');
    expect(errorsOf({ ...raw, popups: { ...(raw['popups'] as object), from: ['nope'] } })).toContain('popups reads unknown ruleset "nope"');
  });
});

describe('load helpers', () => {
  test('parseJsonWith names the file for bad JSON and for schema issues', () => {
    expect(() => parseJsonWith(ListsConfigSchema, '{', 'x.json')).toThrow(/x\.json: not valid JSON/);
    expect(() => parseJsonWith(ListsConfigSchema, '{}', 'x.json')).toThrow(/x\.json: schema/);
  });

  test('loadLock returns an empty lock when the file does not exist and validates one that does', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lock-'));
    expect(await loadLock(path.join(dir, 'missing.json'))).toEqual(EMPTY_LOCK);
    const file = path.join(dir, 'lists.lock.json');
    writeFileSync(file, '{"schema":1,"lists":{"a":{"url":"https://x.example/","sha256":"zz"}}}');
    await expect(loadLock(file)).rejects.toThrow(/lists\.a/);
  });
});
