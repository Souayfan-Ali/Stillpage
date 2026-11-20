import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { EntitiesSchema, entityIndex, unusedDomains, type Entities } from '../../../../compiler/entities/schema.js';
import { MAX_COMPANIES } from '../../../../src/core/limits.js';

const FILE = path.resolve(import.meta.dirname, '../../../../lists/entities.json');
const committed = (): unknown => JSON.parse(readFileSync(FILE, 'utf8'));
const errors = (v: unknown): string[] => {
  const r = EntitiesSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};
const map = (companies: Entities['companies']): Entities => ({ schema: 1, companies });

describe('entities.json', () => {
  test('the committed map is valid and has at most 300 companies', () => {
    const e = EntitiesSchema.parse(committed());
    expect(e.companies.length).toBeGreaterThan(0);
    expect(e.companies.length).toBeLessThanOrEqual(MAX_COMPANIES);
  });

  test('no domain in two companies, none nested under another listed domain, no duplicate ids', () => {
    expect(errors(map([{ id: 'a', name: 'A', domains: ['x.example'] }, { id: 'b', name: 'B', domains: ['x.example'] }])))
      .toContain('domain "x.example" is listed by "a" and "b"');
    expect(errors(map([{ id: 'a', name: 'A', domains: ['x.example'] }, { id: 'b', name: 'B', domains: ['ads.x.example'] }])))
      .toContain('domain "ads.x.example" (b) is under "x.example" (a)');
    expect(errors(map([{ id: 'a', name: 'A', domains: ['x.example'] }, { id: 'a', name: 'A2', domains: ['y.example'] }])))
      .toContain('duplicate company id "a"');
  });

  test('domains must be lower-case hostnames with a dot; more than 300 companies is refused', () => {
    expect(errors(map([{ id: 'a', name: 'A', domains: ['Upper.Example'] }])).length).toBeGreaterThan(0);
    expect(errors(map([{ id: 'a', name: 'A', domains: ['localhost'] }])).length).toBeGreaterThan(0);
    const many = Array.from({ length: MAX_COMPANIES + 1 }, (_, i) => ({ id: `c${String(i)}`, name: 'C', domains: [`c${String(i)}.example`] }));
    expect(errors(map(many)).length).toBeGreaterThan(0);
  });

  test('lookup walks parents; unknown and invalid hosts have no company', () => {
    const idx = entityIndex(map([{ id: 'g', name: 'G', domains: ['doubleclick.example', 'g.example'] }]));
    expect(idx('ad.doubleclick.example')).toBe('g');
    expect(idx('g.example')).toBe('g');
    expect(idx('notg.example')).toBeUndefined();
    expect(idx('not a host')).toBeUndefined();
  });

  test('unusedDomains lists entries no host of the build falls under', () => {
    const e = map([{ id: 'g', name: 'G', domains: ['used.example', 'unused.example'] }]);
    expect(unusedDomains(e, ['a.used.example', 'other.example', 'bad host'])).toEqual(['unused.example']);
  });
});
