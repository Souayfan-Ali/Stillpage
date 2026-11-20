import { describe, expect, test } from 'vitest';
import { readCatalog } from '../../../../src/core/catalog/read.js';
import { parsePackId, parseRulesetId, type PackId, type RulesetId } from '../../../../src/core/ids.js';
import { rawCatalog } from './fixtures.js';

const rid = (s: string): RulesetId => parseRulesetId(s) ?? expect.fail(`bad id ${s}`);
const pid = (s: string): PackId => parsePackId(s) ?? expect.fail(`bad id ${s}`);

function errorsOf(input: unknown): readonly string[] {
  const result = readCatalog(input);
  return result.ok ? [] : result.errors;
}

describe('readCatalog: valid input', () => {
  test('returns typed packs and rulesets', () => {
    const result = readCatalog(rawCatalog());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schema).toBe(1);
    expect(result.value.packs[pid('ads')]?.rulesets).toEqual(['ubo', 'ubo-x']);
    expect(result.value.rulesets[rid('ubo')]?.maxRules).toBe(6900);
  });

  test('marks every -x ruleset as needing host access and the others as not', () => {
    const result = readCatalog(rawCatalog());
    if (!result.ok) return expect.fail(result.errors.join());

    expect(result.value.rulesets[rid('ubo-x')]?.needsHostAccess).toBe(true);
    expect(result.value.rulesets[rid('ubo')]?.needsHostAccess).toBe(false);
  });

  test('carries a licence state per pack', () => {
    const result = readCatalog(rawCatalog());
    if (!result.ok) return expect.fail(result.errors.join());

    expect(result.value.packs[pid('ads')]?.licence).toBe('cleared');
    expect(result.value.packs[pid('reg-zh')]?.licence).toBe('owner-pending');
  });

  test('does not share objects with the input', () => {
    const input = rawCatalog();
    const result = readCatalog(input);
    if (!result.ok) return expect.fail(result.errors.join());

    expect(result.value.packs).not.toBe(input['packs']);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.packs[pid('ads')]?.rulesets)).toBe(true);
  });
});

describe('readCatalog: invalid input', () => {
  test.each([null, 42, 'catalog', [], {}])('rejects %j', (input) => {
    expect(readCatalog(input).ok).toBe(false);
  });

  test('rejects an unknown schema version', () => {
    expect(errorsOf({ ...rawCatalog(), schema: 2 }).length).toBeGreaterThan(0);
  });

  test('rejects unknown keys', () => {
    expect(errorsOf({ ...rawCatalog(), extra: true }).length).toBeGreaterThan(0);
  });

  test('reports a pack that references a missing ruleset', () => {
    const input = rawCatalog();
    const packs = input['packs'] as Record<string, unknown>;
    const bad = { ...input, packs: { ...packs, ads: { rulesets: ['ubo', 'nope'], default: true, licence: 'cleared' } } };

    expect(errorsOf(bad)).toContainEqual(expect.stringContaining('nope'));
  });

  test('reports a -x ruleset that claims not to need host access', () => {
    const input = rawCatalog();
    const rulesets = input['rulesets'] as Record<string, unknown>;
    const bad = { ...input, rulesets: { ...rulesets, 'ubo-x': { needsHostAccess: false, maxRules: 1, maxRegex: 0 } } };

    expect(errorsOf(bad)).toContainEqual(expect.stringContaining('ubo-x'));
  });

  test('reports a safe ruleset that claims to need host access', () => {
    const input = rawCatalog();
    const rulesets = input['rulesets'] as Record<string, unknown>;
    const bad = { ...input, rulesets: { ...rulesets, ubo: { needsHostAccess: true, maxRules: 1, maxRegex: 0 } } };

    expect(errorsOf(bad)).toContainEqual(expect.stringContaining('ubo'));
  });

  test('reports invalid ruleset and pack ids', () => {
    const input = rawCatalog();
    const rulesets = input['rulesets'] as Record<string, unknown>;
    const packs = input['packs'] as Record<string, unknown>;
    const bad = {
      ...input,
      rulesets: { ...rulesets, Bad_Id: { needsHostAccess: false, maxRules: 1, maxRegex: 0 } },
      packs: { ...packs, 'Bad Pack': { rulesets: [], default: false, licence: 'cleared' } },
    };

    expect(errorsOf(bad)).toEqual(
      expect.arrayContaining([expect.stringContaining('Bad_Id'), expect.stringContaining('Bad Pack')]),
    );
  });

  test('rejects an unknown licence state', () => {
    const input = rawCatalog();
    const packs = input['packs'] as Record<string, unknown>;
    const bad = { ...input, packs: { ...packs, ads: { rulesets: ['ubo'], default: true, licence: 'maybe' } } };

    expect(readCatalog(bad).ok).toBe(false);
  });

  test.each([
    ['negative rules', { needsHostAccess: false, maxRules: -1, maxRegex: 0 }],
    ['fractional rules', { needsHostAccess: false, maxRules: 1.5, maxRegex: 0 }],
    ['regex over the static pool', { needsHostAccess: false, maxRules: 1, maxRegex: 1001 }],
  ])('rejects a ruleset with %s', (_name, entry) => {
    const input = rawCatalog();
    const rulesets = input['rulesets'] as Record<string, unknown>;

    expect(readCatalog({ ...input, rulesets: { ...rulesets, ubo: entry } }).ok).toBe(false);
  });

  test('reports a ruleset listed by two packs', () => {
    const input = rawCatalog();
    const packs = input['packs'] as Record<string, unknown>;
    const bad = { ...input, packs: { ...packs, extra: { rulesets: ['ubo'], default: false, licence: 'cleared' } } };

    expect(errorsOf(bad)).toContainEqual(expect.stringContaining('ubo'));
  });

  test('reports more rulesets than Chrome lets an extension declare', () => {
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`r${String(i)}`, { needsHostAccess: false, maxRules: 1, maxRegex: 0 }]),
    );

    expect(errorsOf({ schema: 1, rulesets: many, packs: {} })).toContainEqual(expect.stringContaining('100'));
  });
});

describe('readCatalog: registration templates', () => {
  const registration = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'iso:ads:17',
    world: 'ISOLATED',
    js: ['cs/ads/17.js'],
    hosts: ['example.com', 'news.example.org'],
    ...over,
  });

  function withRegistrations(ads: unknown[], trackers: unknown[] = []): Record<string, unknown> {
    const input = rawCatalog();
    const packs = input['packs'] as Record<string, Record<string, unknown>>;
    return {
      ...input,
      packs: {
        ...packs,
        ads: { ...packs['ads'], registrations: ads },
        trackers: { ...packs['trackers'], registrations: trackers },
      },
    };
  }

  test('defaults to no registrations', () => {
    const result = readCatalog(rawCatalog());
    if (!result.ok) return expect.fail(result.errors.join());
    expect(result.value.packs[pid('ads')]?.registrations).toEqual([]);
  });

  test('reads valid templates and freezes them', () => {
    const result = readCatalog(withRegistrations([registration(), registration({ id: 'main:ads:17', world: 'MAIN' })]));
    if (!result.ok) return expect.fail(result.errors.join());

    const regs = result.value.packs[pid('ads')]?.registrations ?? [];
    expect(regs.map((r) => r.id)).toEqual(['iso:ads:17', 'main:ads:17']);
    expect(Object.isFrozen(regs[0]?.hosts)).toBe(true);
  });

  test.each([
    ['an id starting with _', { id: '_x' }],
    ['an empty js list', { js: [] }],
    ['a path with ..', { js: ['../secret.js'] }],
    ['an absolute path', { js: ['/cs/a.js'] }],
    ['a non-js file', { js: ['cs/a.json'] }],
    ['an unknown world', { world: 'USER' }],
    ['no hosts', { hosts: [] }],
  ])('rejects %s', (_name, over) => {
    expect(readCatalog(withRegistrations([registration(over)])).ok).toBe(false);
  });

  test.each([
    ['an invalid host', { hosts: ['not a host'] }],
    ['a non-canonical host', { hosts: ['Example.com'] }],
    ['a repeated host', { hosts: ['a.com', 'a.com'] }],
  ])('reports %s', (_name, over) => {
    expect(errorsOf(withRegistrations([registration(over)]))).toContainEqual(expect.stringContaining('host'));
  });

  test('reports duplicate ids within and across packs', () => {
    expect(errorsOf(withRegistrations([registration(), registration()]))).toContainEqual(
      expect.stringContaining('duplicate id'),
    );
    expect(errorsOf(withRegistrations([registration()], [registration()]))).toContainEqual(
      expect.stringContaining('duplicate id'),
    );
  });
});

describe('readCatalog: prototype keys (review HIGH)', () => {
  test.each(['constructor', 'toString', 'hasOwnProperty'])('reports a pack referencing "%s"', (name) => {
    const input = rawCatalog();
    const packs = input['packs'] as Record<string, unknown>;
    const bad = { ...input, packs: { ...packs, ads: { rulesets: [name], default: true, licence: 'cleared' } } };

    expect(errorsOf(bad)).toContainEqual(expect.stringContaining(name));
  });
});
