import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { applyVariant, defaultRegistrations, registrationsOf, scriptBytes } from '../../../bench/diag/variants.js';

const reg = (id: string, world: string, hosts: string[]) => ({ id, world, js: [`${id}.js`], hosts });
const REG = JSON.stringify({ schema: 1, packs: { ads: [reg('a', 'ISOLATED', ['x.example', 'y.example']), reg('b', 'ISOLATED', ['z.example']), reg('c', 'MAIN', ['m.example'])] } });
const BUILD = new Map([
  ['registrations.json', REG],
  ['catalog.json', JSON.stringify({ schema: 1, registrations: { path: 'registrations.json', sha256: 'old' }, packs: { ads: { rulesets: ['ubo'] } } })],
  ['manifest.json', JSON.stringify({ declarative_net_request: { rule_resources: [{ id: 'ubo', enabled: true, path: 'rulesets/ubo.json' }] } })],
  ['background.js', 'a({persistAcrossSessions:!0});b({persistAcrossSessions:!1})'],
]);

const json = (files: ReadonlyMap<string, string>, name: string): Record<string, unknown> => JSON.parse(files.get(name) ?? '{}') as Record<string, unknown>;
const regs = (files: ReadonlyMap<string, string>) => (json(files, 'registrations.json') as { packs: { ads: { id: string; world: string; hosts: string[] }[] } }).packs.ads;
const catalogSha = (files: ReadonlyMap<string, string>) => (json(files, 'catalog.json') as { registrations: { sha256: string } }).registrations.sha256;
const sha = (t: string | undefined) => createHash('sha256').update(t ?? '').digest('hex');

describe('diagnosis variants (P2-47)', () => {
  test('full is the build unchanged', () => {
    expect(applyVariant(BUILD, 'full')).toBe(BUILD);
  });

  test('registration variants keep the catalog hash consistent so the worker accepts them', () => {
    for (const v of ['no-registrations', 'one-host-each', 'two-registrations'] as const) {
      const out = applyVariant(BUILD, v);
      expect(catalogSha(out)).toBe(sha(out.get('registrations.json')));
    }
  });

  test('no-registrations empties every pack; one-host-each keeps the count with one host; two-registrations merges per world', () => {
    expect(regs(applyVariant(BUILD, 'no-registrations'))).toEqual([]);
    expect(regs(applyVariant(BUILD, 'one-host-each')).map((r) => r.hosts)).toEqual([['x.example'], ['z.example'], ['m.example']]);
    expect(regs(applyVariant(BUILD, 'two-registrations')).map((r) => [r.world, r.hosts])).toEqual([
      ['ISOLATED', ['x.example', 'y.example', 'z.example']],
      ['MAIN', ['m.example']],
    ]);
  });

  test('no-rulesets disables every static ruleset and leaves packs without rulesets', () => {
    const out = applyVariant(BUILD, 'no-rulesets');
    expect(json(out, 'manifest.json')).toEqual({ declarative_net_request: { rule_resources: [{ id: 'ubo', enabled: false, path: 'rulesets/ubo.json' }] } });
    expect(json(out, 'catalog.json')['packs']).toEqual({ ads: { rulesets: [] } });
  });

  test('unique-js-only drops every file another registration also names, keeping a registration non-empty', () => {
    const shared = JSON.stringify({ schema: 1, packs: { ads: [{ id: 'a', world: 'ISOLATED', js: ['a.js', 'common.js'], hosts: ['x.example'] }, { id: 'b', world: 'ISOLATED', js: ['common.js'], hosts: ['y.example'] }] } });
    const out = applyVariant(new Map([...BUILD, ['registrations.json', shared]]), 'unique-js-only');
    expect((json(out, 'registrations.json') as { packs: { ads: { js: string[] }[] } }).packs.ads.map((r) => r.js)).toEqual([['a.js'], ['common.js']]);
  });

  test('grouped-N merges consecutive registrations of one pack and world, js and hosts de-duplicated', () => {
    const many = JSON.stringify({ schema: 1, packs: { ads: Array.from({ length: 256 }, (_, i) => ({ id: `r${String(i)}`, world: 'ISOLATED', js: [`d${String(i)}.js`, 'common.js'], hosts: [`h${String(i)}.example`] })) } });
    const out = regs(applyVariant(new Map([...BUILD, ['registrations.json', many]]), 'grouped-64')) as unknown as { js: string[]; hosts: string[] }[];
    expect(out).toHaveLength(64);
    expect(out[0]?.js).toEqual(['d0.js', 'common.js', 'd1.js', 'd2.js', 'd3.js']);
    expect(out.flatMap((r) => r.hosts)).toHaveLength(256);
  });

  test('six-one-host: one registration per world with a single host', () => {
    expect(regs(applyVariant(BUILD, 'six-one-host')).map((r) => [r.world, r.hosts])).toEqual([['ISOLATED', ['x.example']], ['MAIN', ['m.example']]]);
  });

  test('scriptBytes: summed over registrations counts repeats, unique counts each file once', () => {
    const sizes: Record<string, number> = { 'a.js': 10, 'b.js': 1, 'c.js': 2, 'm.js': 5 };
    const packs = registrationsOf(JSON.stringify({ schema: 1, packs: { ads: [{ id: 'a', world: 'I', js: ['a.js', 'b.js'], hosts: [] }, { id: 'b', world: 'I', js: ['a.js', 'c.js'], hosts: [] }] } }));
    expect(scriptBytes(packs, (f) => sizes[f] ?? 0)).toEqual({ summed: 23, unique: 13, top: [['a.js', 20], ['c.js', 2], ['b.js', 1]] });
  });

  test('non-persistent turns every persistent registration call into a session one', () => {
    expect(applyVariant(BUILD, 'non-persistent').get('background.js')).toBe('a({persistAcrossSessions:!1});b({persistAcrossSessions:!1})');
  });
  test('defaultRegistrations: keeps the packs the catalog marks default (what a fresh install registers, P2-47)', () => {
    const packs = registrationsOf(JSON.stringify({ schema: 1, packs: { ads: [{ id: 'a', world: 'I', js: ['a.js'], hosts: [] }], cookies: [{ id: 'c', world: 'I', js: ['c.js'], hosts: [] }] } }));
    const catalog = JSON.stringify({ packs: { ads: { default: true }, cookies: { default: false } } });
    expect(Object.keys(defaultRegistrations(packs, catalog))).toEqual(['ads']);
  });
});
