/** Content batch review fixes (security H1, H2, M3, M4, L5; TypeScript HIGH 1, 2, MEDIUM 3). */
import { describe, expect, test } from 'vitest';
import type { ConvertedRule } from '../../../compiler/convert/convert.js';
import type { DnrRule } from '../../../compiler/dnr/schema.js';
import { switchHost } from '../../../compiler/content/build.js';
import { emitPackContent } from '../../../compiler/content/shards.js';
import { readShardFile, verifyContent } from '../../../compiler/verify/content.js';
import { readLibrary, resolver } from '../../../compiler/scriptlets/library.js';
import { redirectProblems, surrogateFiles } from '../../../compiler/surrogates/files.js';
import { resolveRedirects, resourceIndex } from '../../../compiler/surrogates/redirects.js';
import { readCompiled } from '../../../compiler/vendor/ubo.js';
import { commonDataPath } from '../../../src/core/content/files.js';
import { shardFileWrap } from '../../../src/core/content/shard-data.js';
import { entry, fact } from './content/helpers.js';

const redirectRule = (redirect: NonNullable<DnrRule['action']['redirect']>, types?: string[]): ConvertedRule => ({
  rule: { id: 1, priority: 2, action: { type: 'redirect', redirect }, condition: { regexFilter: '^https://a\\.example/(.*)', ...(types && { resourceTypes: types as never }) } },
  sources: [{ text: '||a.example^$redirect=noopvast4', source: { list: 'l', line: 1, text: '||a.example^$redirect=noopvast4' }, fixes: [] }],
});

describe('redirects stay inside the package (security H1, H2)', () => {
  test('a regexSubstitution that does more than re-assemble captures, and a transform that moves the request, are dropped', () => {
    const r = resolveRedirects([redirectRule({ regexSubstitution: 'https://evil.example/\\1' }), redirectRule({ regexSubstitution: '\\1\\2' }),
      redirectRule({ transform: { host: 'evil.example' } }), redirectRule({ transform: { queryTransform: { removeParams: ['x'] } } })], new Map());
    expect(r.log.map((l) => l.reason)).toEqual(['redirect-external', 'redirect-external']);
    expect(r.rules).toHaveLength(2);
    expect(redirectProblems([{ id: 1, action: { type: 'redirect', redirect: { regexSubstitution: 'x\\1' } }, condition: {} }], new Map())).toHaveLength(1);
  });

  test('XML surrogates never on frame types; only known file types ship', () => {
    const idx = resourceIndex([{ name: 'noop-vast4.xml', aliases: ['noopvast4'] }]);
    const path = { extensionPath: '/surrogates/x' };
    expect(resolveRedirects([redirectRule(path, ['xmlhttprequest'])], idx).rules).toHaveLength(1);
    expect(resolveRedirects([redirectRule(path, ['sub_frame'])], idx).log.map((l) => l.reason)).toEqual(['redirect-html-type']);
    expect(resolveRedirects([redirectRule(path)], idx).log.map((l) => l.reason)).toEqual(['redirect-html-type']);
    expect(() => surrogateFiles(['evil.svg'], new Map([['evil.svg', new Uint8Array()]]))).toThrow(/file type/);
    expect(redirectProblems([{ id: 1, action: { type: 'redirect', redirect: { extensionPath: '/other/noop.js' } }, condition: {} }], new Map())).toHaveLength(1);
  });
});

describe('scriptlet trust fails closed (security M3)', () => {
  const lib = (trust: string, name = 'x.js') => readLibrary(new Map([['a.js', `function f() {}\nregisterScriptlet(f, { name: '${name}'${trust} });`]]), []);
  test.each([[', requiresTrust: true', true], [', requiresTrust: SOME_CONST', true], [', requiresTrust: false', false], ['', false]])('requiresTrust%s → %s', (trust, want) => {
    expect(resolver(lib(trust))('x')?.requiresTrust).toBe(want);
  });
  test('a trusted-* name always requires trust; two definitions of one name fail the build', () => {
    expect(resolver(lib(', requiresTrust: false', 'trusted-x.js'))('trusted-x')?.requiresTrust).toBe(true);
    const two = readLibrary(new Map([['a.js', "function f() {}\nregisterScriptlet(f, { name: 'a.js' });\nfunction g() {}\nregisterScriptlet(g, { name: 'b.js', aliases: ['a.js'] });"]]), []);
    expect(() => resolver(two)).toThrow(/claimed/);
  });
});

describe('inputs that must not widen or crash (security M4, L5)', () => {
  test('a cosmetic switch on a suffix or a malformed host is ignored', () => {
    expect(switchHost(entry('@@||com^$elemhide'))).toBeNull();
    expect(switchHost(entry('@@||a..b^$ehide'))).toBeNull();
    expect(switchHost(entry('@@||site.example^$ehide'))).toBe('site.example');
  });
  test('readCompiled refuses malformed JSON instead of throwing', () => {
    expect(readCompiled('{not json')).toEqual({ kind: 'invalid' });
  });
});

describe('the verify stage checks every index (TypeScript HIGH 1, 2, MEDIUM 3)', () => {
  const iso = shardFileWrap('ISOLATED');
  const wrap = (o: unknown) => `${iso.prefix}${JSON.stringify(o)}${iso.suffix}`;
  const base = { v: 1, pack: 'ads', shard: 0, hosts: ['a.com'], entries: [{ h: [0] }], selectors: ['.x'], styles: [], procedural: [], invocations: [] };
  test.each([
    ['an index past its table', { ...base, entries: [{ h: [1] }] }],
    ['a negative selector index', { ...base, entries: [{ h: [-1] }] }],
    ['unsorted hosts', { ...base, hosts: ['b.com', 'a.com'], entries: [{}, {}] }],
    ['a non-hostname', { ...base, hosts: ['A B'] }],
    ['an unknown key', { ...base, extra: 1 }],
    ['a selector that is not a string', { ...base, selectors: [1] }],
  ])('refuses %s', (_n, data) => {
    expect(readShardFile(wrap(data), 'ISOLATED')).toBeNull();
  });
  test('negative j indices must fall inside the common table', () => {
    const data = { ...base, entries: [{ j: [-1] }] };
    expect(readShardFile(wrap(data), 'ISOLATED', 1)).not.toBeNull();
    expect(readShardFile(wrap(data), 'ISOLATED', 0)).toBeNull();
  });
  test('a missing scriptlet index fails the emitter instead of pointing at the common table', () => {
    expect(() => emitPackContent({ pack: 'ads', isolated: [], main: [fact('a.com', 'j', '["gone"]')], fnIndex: () => { throw new Error('gone'); } })).toThrow(/gone/);
  });
  test('an oversized or malformed common table fails verify', () => {
    const files = new Map([[commonDataPath('ads', 'MAIN'), 'not a table']]);
    expect(verifyContent({ files, registrations: new Map(), defaultPacks: new Set() }).join()).toMatch(/not a common table/);
  });
});
