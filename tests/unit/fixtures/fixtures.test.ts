import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseHostname } from '../../../src/core/hostname/validate.js';
import { uncoveredRedirects } from '../../../compiler/postpass/split.js';
import { FAMILIES, FIXTURES_DIR, loadFixtures, type Observation } from '../../fixtures/manifest.js';
import { compileSplit } from '../../helpers/compileFilters.js';

/** P1-42/P1-43: the fixture manifest is well-formed and every fixture page is where it says. */
const fixtures = loadFixtures();
const UNSAFE = new Set(['redirect', 'modifyHeaders']);
/** Filters that become DNR rules: not cosmetic or scriptlet lines, not cosmetic-only exceptions. */
const isNetwork = (filter: string): boolean => !/#[@?$%]?#|#\+js\(|\$(?:generic|elem|specific|g|e|s)hide$/.test(filter);

const observedUrl = (o: Observation): string | null => ('request' in o ? o.request : 'navigation' in o ? o.navigation : null);

describe('fixtures.json', () => {
  test('ids are unique and start with their family', () => {
    const ids = fixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fixtures.filter((f) => !f.id.startsWith(`${f.family}/`)).map((f) => f.id)).toEqual([]);
  });

  test.each(fixtures.map((f) => [f.id, f] as const))('%s: page file exists in its family and names the fixture', (_id, fixture) => {
    const file = path.join(FIXTURES_DIR, fixture.file);
    expect(existsSync(file)).toBe(true);
    expect(fixture.file.startsWith(`${fixture.family}/`)).toBe(true);
    expect(new URL(fixture.page).pathname).toBe(`/${fixture.file}`);
    const html = readFileSync(file, 'utf8');
    const comment = /<!-- fixture: ([^·]+)·/.exec(html)?.[1] ?? '';
    expect(comment.includes(fixture.id) || comment.includes(`${fixture.family}/*`)).toBe(true);
  });

  test.each(fixtures.map((f) => [f.id, f] as const))('%s: every address is on a valid hostname', (_id, fixture) => {
    const urls = [fixture.page, ...fixture.expect.map(observedUrl).filter((u) => u !== null)];
    expect(urls.filter((u) => parseHostname(new URL(u).hostname) !== new URL(u).hostname)).toEqual([]);
  });

  test('the fixtures\' filters compile with the real post-pass: nothing dropped, unsafe rules only for redirect/ and permissions/ (P1-44)', async () => {
    const network = fixtures.filter((f) => f.filters.some(isNetwork));
    const compiled = await Promise.all(network.map(async (f) => ({ f, out: await compileSplit(f.filters.filter(isNetwork)) })));
    const dropped = compiled.filter(({ f, out }) => out.safe.length + out.unsafe.length < f.filters.filter(isNetwork).length).map(({ f }) => f.id);
    expect(dropped).toEqual([]);
    const unsafeFamilies = new Set(compiled.filter(({ out }) => out.unsafe.some((b) => UNSAFE.has(b.rule.action.type))).map(({ f }) => f.family));
    expect([...unsafeFamilies].sort()).toEqual(['permissions', 'redirect']);
    expect(compiled.flatMap(({ f, out }) => uncoveredRedirects(out.safe, out.unsafe).map(() => f.id))).toEqual([]);
  });

  test('every HTML file in a family directory is a fixture page or used by one', () => {
    const referenced = new Set(fixtures.flatMap((f) => [f.file, ...(f.uses ?? [])]));
    const onDisk = FAMILIES.flatMap((family) => {
      const dir = path.join(FIXTURES_DIR, family);
      return existsSync(dir)
        ? readdirSync(dir)
            .filter((n) => n.endsWith('.html'))
            .map((n) => `${family}/${n}`)
        : [];
    });
    expect(onDisk.filter((file) => !referenced.has(file))).toEqual([]);
    expect([...referenced].filter((file) => !onDisk.includes(file))).toEqual([]);
  });

  test('levels/ covers Off, Light, Standard, Thorough and a pause; permissions/ covers none, site, revoked', () => {
    const ids = new Set(fixtures.map((f) => f.id));
    for (const id of [
      'levels/off',
      'levels/light',
      'levels/standard',
      'levels/thorough',
      'levels/pause-expiry',
      'permissions/no-access',
      'permissions/site-access',
      'permissions/revoked',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test('a pending fixture names the task that builds its feature', () => {
    expect(fixtures.filter((f) => f.pending !== undefined && !/^P[12]-\d\d: .{20,}/.test(f.pending)).map((f) => f.id)).toEqual([]);
  });
});

describe('P1-43 families', () => {
  test.each(['cosmetic-specific', 'cosmetic-procedural', 'cosmetic-generic', 'scriptlets', 'anti-adblock'])('%s has fixtures', (family) => {
    expect(fixtures.filter((f) => f.family === family).length).toBeGreaterThanOrEqual(4);
  });

  test('anti-adblock covers the bait element, the bait request, a missing global and a timer check', () => {
    const names = fixtures.filter((f) => f.family === 'anti-adblock').map((f) => f.id.split('/')[1]);
    expect(names).toEqual(expect.arrayContaining(['bait-element', 'bait-request', 'missing-global', 'timer-check']));
  });

  test('scriptlets cover MAIN against an inline script and an ISOLATED one', () => {
    const ids = fixtures.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['scriptlets/ordering', 'scriptlets/isolated-world']));
  });
});
