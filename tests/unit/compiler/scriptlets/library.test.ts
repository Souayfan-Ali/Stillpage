import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { closure, readLibrary, resolver } from '../../../../compiler/scriptlets/library.js';
import { loadLibrary } from '../../../../compiler/scriptlets/port.js';
import { loadVendorLock } from '../../../../compiler/vendor/node-ports.js';
import { readRedirectResources } from '../../../../compiler/vendor/resources.js';
import { VENDOR_PRESENT } from '../content/helpers.js';

const FILES = new Map([
  ['base.js', `export function safeSelf() { return {}; }
registerScriptlet(safeSelf, { name: 'safe-self.fn' });
function helperFn() { return safeSelf(); }
registerScriptlet(helperFn, { name: 'helper.fn', dependencies: [safeSelf] });`],
  ['a.js', `function setConstant(a, b) { helperFn(); }
registerScriptlet(setConstant, { name: 'set-constant.js', aliases: ['set.js'], dependencies: [helperFn] });
export function trustedThing() {}
registerScriptlet(trustedThing, { name: 'trusted-thing.js', requiresTrust: true, world: 'ISOLATED' });`],
  ['old.js', `function oldFn() {}
builtinScriptlets.push({ name: 'old-style.js', fn: oldFn, dependencies: ['safe-self.fn'] });`],
]);

describe('uBO scriptlet library, read without executing it (P1-29)', () => {
  const lib = readLibrary(FILES, [{ file: 'noeval.js', aliases: ['silent-noeval.js'], text: '(function(){})();' }]);
  const resolve = resolver(lib);

  test('both registration forms, worlds, trust and dependencies', () => {
    expect(resolve('set-constant')).toMatchObject({ name: 'set-constant', world: 'MAIN', requiresTrust: false, fn: 'setConstant', deps: ['helperFn'] });
    expect(resolve('trusted-thing.js')).toMatchObject({ world: 'ISOLATED', requiresTrust: true });
    expect(resolve('old-style')).toMatchObject({ fn: 'oldFn', deps: ['safeSelf'] });
  });

  test('aliases, .js suffixes and web-accessible JS resources resolve; helpers do not', () => {
    expect(resolve('set.js')?.name).toBe('set-constant');
    expect(resolve('noeval.js')?.name).toBe('noeval');
    expect(resolve('silent-noeval')?.name).toBe('noeval');
    expect(resolve('safe-self.fn')).toBeUndefined();
    expect(resolve('nope')).toBeUndefined();
  });

  test('closure lists dependencies first, once', () => {
    const defs = ['set-constant', 'old-style'].map((n) => resolve(n)).filter((d) => d !== undefined);
    expect(closure(lib, defs)).toEqual(['safeSelf', 'oldFn', 'helperFn', 'setConstant']);
  });

  test('a registration whose function is missing fails the build', () => {
    expect(() => readLibrary(new Map([['x.js', "registerScriptlet(gone, { name: 'x.js' });"]]), [])).toThrow(/gone/);
  });

  test('redirect resources: names and aliases (string or array)', () => {
    const src = "export default new Map([\n  [ 'a.js', { alias: 'b.js' } ],\n  [ 'c.gif', { alias: [ 'd', 'e' ], data: 'blob' } ],\n  [ 'f', {} ],\n]);";
    expect(readRedirectResources(src)).toEqual([{ name: 'a.js', aliases: ['b.js'] }, { name: 'c.gif', aliases: ['d', 'e'] }, { name: 'f', aliases: [] }]);
    expect(() => readRedirectResources('export default 1;')).toThrow(/Map/);
  });
});

describe.skipIf(!VENDOR_PRESENT)('the vendored library (P1-29)', () => {
  test('resolves every scriptlet token of the pinned default lists: 92 tokens → 76 names', async () => {
    const lib = await loadLibrary(await loadVendorLock());
    const resolve = resolver(lib);
    const golden = JSON.parse(readFileSync(new URL('../../../golden/compiler/scriptlet-names.json', import.meta.url), 'utf8')) as { tokens: Record<string, string | null> };
    const got = Object.fromEntries(Object.keys(golden.tokens).map((t) => [t, resolve(t)?.name ?? null]));
    expect(got).toEqual(golden.tokens);
    expect(new Set(Object.values(got)).size).toBe(76);
    expect(Object.values(got)).not.toContain(null);
  });
});
