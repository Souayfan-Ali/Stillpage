import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, test } from 'vitest';
import { buildContent } from '../../../../compiler/content/build.js';
import { stemIndex } from '../../../../compiler/entities/expand.js';
import { bundle } from '../../../../compiler/scriptlets/bundle.js';
import { expandAllExceptions, scriptletFacts } from '../../../../compiler/scriptlets/facts.js';
import { readLibrary, resolver } from '../../../../compiler/scriptlets/library.js';
import { scriptletPort } from '../../../../compiler/scriptlets/port.js';
import { loadVendorLock } from '../../../../compiler/vendor/node-ports.js';
import { loadUboParser, type UboParser } from '../../../../compiler/vendor/ubo.js';
import { verifyContent } from '../../../../compiler/verify/content.js';
import { commonDataPath, mainDataPath, scriptletCodePath } from '../../../../src/core/content/files.js';
import type { Hostname } from '../../../../src/core/ids.js';
import { entry, fact, VENDOR_PRESENT } from '../content/helpers.js';

const FILES = new Map([['a.js', `function record(name) { return (...args) => self.calls.push([name, ...args]); }
function setConstant(...a) { record('set-constant')(...a); }
registerScriptlet(setConstant, { name: 'set-constant.js', dependencies: [record] });
function abortRead(...a) { record('abort-on-property-read')(...a); }
registerScriptlet(abortRead, { name: 'abort-on-property-read.js', aliases: ['aopr.js'], dependencies: [record] });
function unused() { self.calls.push(['unused']); }
registerScriptlet(unused, { name: 'unused.js' });
function trusted(...a) { record('trusted-x')(...a); }
registerScriptlet(trusted, { name: 'trusted-x.js', requiresTrust: true, dependencies: [record] });`]]);
const lib = readLibrary(FILES, []);
const ctx = { stems: stemIndex(['google.com', 'google.de']) };

/** Runs the files of one MAIN registration in a fresh realm with `location.hostname = host`. */
function run(files: ReadonlyMap<string, string>, js: readonly string[], host: string): unknown[][] {
  const sandbox: Record<string, unknown> = { calls: [], location: { hostname: host, ancestorOrigins: [] }, URL };
  sandbox['self'] = sandbox;
  for (const p of js) runInNewContext(files.get(p) ?? `throw new Error('missing ${p}')`, sandbox);
  return sandbox['calls'] as unknown[][];
}

describe('scriptlet code files (P1-29)', () => {
  test('only referenced scriptlets and their dependencies are bundled; no eval, no Function, no network', () => {
    const resolve = resolver(lib);
    const code = bundle(lib, 'ads', 'MAIN', [resolve('aopr'), resolve('set-constant')].filter((d) => d !== undefined), 'c0ffee');
    expect(code.text).toContain('function abortRead');
    expect(code.text).not.toContain('function unused');
    expect(code.text).toContain('commit c0ffee');
    expect([...code.index]).toEqual([['abort-on-property-read', 0], ['set-constant', 1]]);
    expect(code.text).not.toMatch(/\beval\s*\(|new\s+Function|fetch\(|XMLHttpRequest|sendBeacon|chrome\./);
  });

  describe.skipIf(!VENDOR_PRESENT)('with uBO\'s argument parser', () => {
    let ubo: UboParser;
    beforeAll(async () => { ubo = await loadUboParser(await loadVendorLock()); });

    test('facts: arguments as JSON data, trust enforced, unknown names logged, exceptions and wildcards', () => {
      const resolve = resolver(lib);
      const f = (t: string, trusted = true) => scriptletFacts(entry(t, 'l', trusted), ubo, resolve, ctx);
      expect(f('example.com,~www.example.com##+js(aopr, "a, b", x\\, y)').main.map((x) => `${x.host} ${x.kind} ${x.value}`))
        .toEqual(['example.com j ["abort-on-property-read","a, b","x, y"]', 'www.example.com n ["abort-on-property-read","a, b","x, y"]']);
      expect(f('example.com##+js(trusted-x, 1)', false).log.map((l) => l.reason)).toEqual(['scriptlet-untrusted']);
      expect(f('example.com##+js(trusted-x, 1)', true).main).toHaveLength(1);
      expect(f('example.com##+js(nope, 1)').log[0]).toMatchObject({ reason: 'scriptlet-unknown', detail: 'nope' });
      expect(f('##+js(aopr, x)').log.map((l) => l.reason)).toEqual(['scriptlet-generic']);
      expect(f('google.*##+js(aopr, x)').main.map((x) => x.host)).toEqual(['google.com', 'google.de']);
      const wild = f('example.com#@#+js()').main;
      expect(wild.map((x) => x.value)).toEqual(['*']);
      expect(expandAllExceptions(wild, [fact('www.example.com', 'j', '["a"]'), fact('other.com', 'j', '["b"]')]).map((x) => `${x.host} ${x.value}`)).toEqual(['example.com ["a"]']);
    });

    test('end to end: the dispatcher calls each invocation with its JSON arguments on the host and its sub-hosts only', () => {
      const port = scriptletPort(lib, ubo, 'c0ffee');
      const b = buildContent([{ config: { id: 'r', pack: 'ads' }, entries: [
        entry('example.com##+js(aopr, foo)'), entry('example.com,other.org##+js(set-constant, a.b, "x\\"y")'),
        entry('www.example.com#@#+js(aopr, foo)'), entry('trap.net##+js(aopr, ");alert(1);(")'),
      ] }], ubo, ctx, port);
      const files = b.files;
      const reg = (h: string) => b.registrations.get('ads')?.find((r) => r.world === 'MAIN' && r.hosts.includes(h as Hostname));
      const js = reg('example.com')?.js ?? [];
      expect(js).toEqual([mainDataPath('ads', 0), scriptletCodePath('ads', 'MAIN')]);
      const sorted = (calls: unknown[][]) => calls.map((c) => JSON.stringify(c)).sort();
      expect(sorted(run(files, js, 'example.com'))).toEqual(sorted([['abort-on-property-read', 'foo'], ['set-constant', 'a.b', 'x"y']]));
      expect(run(files, js, 'shop.example.com')).toHaveLength(2);
      expect(run(files, js, 'www.example.com')).toEqual([['set-constant', 'a.b', 'x"y']]);
      expect(run(files, js, 'example.net')).toEqual([]);
      expect(run(files, reg('trap.net')?.js ?? [], 'trap.net')).toEqual([['abort-on-property-read', ');alert(1);(']]);
      expect(verifyContent({ files, registrations: b.registrations, defaultPacks: new Set(['ads']) })).toEqual([]);
    });

    test('invocations shared by several shards come from the common table (negative indices)', () => {
      const entries = Array.from({ length: 3000 }, (_, i) => entry(`site${String(i)}.com##+js(aopr, shared-${'y'.repeat(20)})`));
      const b = buildContent([{ config: { id: 'r', pack: 'ads' }, entries: [...entries, entry('site7.com##+js(set-constant, only, here)')] }], ubo, ctx, scriptletPort(lib, ubo, 'c'));
      const reg = b.registrations.get('ads')?.find((r) => r.hosts.includes('site7.com' as Hostname));
      expect(reg?.js[0]).toBe(commonDataPath('ads', 'MAIN'));
      const calls = run(b.files, reg?.js ?? [], 'site7.com').map((c) => c[0]).sort();
      expect(calls).toEqual(['abort-on-property-read', 'set-constant']);
    });

    describe('hostile realm (P1-37, security notes T1): the page ran before our files', () => {
      const build = () => buildContent([{ config: { id: 'r', pack: 'ads' }, entries: [entry('example.com##+js(aopr, foo)')] }], ubo, ctx, scriptletPort(lib, ubo, 'c'));
      /** Runs `prelude` (the page) in the realm, then our files; returns the scriptlet calls. */
      function hostile(prelude: string): unknown[][] {
        const b = build();
        const js = b.registrations.get('ads')?.[0]?.js ?? [];
        const sandbox: Record<string, unknown> = { calls: [], location: { hostname: 'example.com', origin: 'https://example.com', ancestorOrigins: [] }, URL };
        sandbox['self'] = sandbox;
        runInNewContext(prelude, sandbox);
        for (const p of js) runInNewContext(b.files.get(p) ?? '', sandbox);
        return sandbox['calls'] as unknown[][];
      }
      const FORGED = JSON.stringify({ v: 1, pack: 'ads', shard: 0, hosts: ['example.com'], entries: [{ j: [0] }], selectors: [], styles: [], procedural: [], invocations: [[0, 'forged']] });

      test('control: an untouched realm runs the list invocation', () => {
        expect(hostile('')).toEqual([['abort-on-property-read', 'foo']]);
      });

      test.each([
        ['a pre-seeded array queue with a forged datum', `self.__sl_q = [${FORGED}];`],
        ['a pre-seeded slot holder with a forged datum', `self.__sl_q = Object.create(null); self.__sl_q.s = ${FORGED};`],
        ['an accessor queue', `Object.defineProperty(self, '__sl_q', { get() { return [${FORGED}]; }, set() {}, configurable: true });`],
        ['a non-configurable queue', `Object.defineProperty(self, '__sl_q', { value: [], configurable: false, writable: true });`],
        ['a frozen null-prototype holder carrying a forged slot (security review M1)', `const h = Object.create(null); h.s = ${FORGED}; Object.freeze(h); Object.defineProperty(self, '__sl_q', { value: h, configurable: true });`],
        ['a Proxy holder that claims a null prototype', `const t = Object.create(null); t.s = ${FORGED}; self.__sl_q = new Proxy(t, { getPrototypeOf: () => null, set: () => true, defineProperty: () => true });`],
      ])('%s: nothing forged runs, and the list invocation runs at most unchanged', (_name, prelude) => {
        const calls = hostile(prelude);
        expect(calls.some((c) => c.includes('forged'))).toBe(false);
        expect(calls.every((c) => JSON.stringify(c) === JSON.stringify(['abort-on-property-read', 'foo']))).toBe(true);
      });

      test('poisoned Array.prototype methods and iterators are never called by the dispatcher', () => {
        const prelude = `self.poisoned = 0;
          for (const m of ['push', 'filter', 'includes', 'slice', 'sort', 'indexOf']) { const o = Array.prototype[m]; Array.prototype[m] = function (...a) { self.poisoned += 1; self.where = (self.where || '') + ' ' + m; return o.apply(this, a); }; }
          const it = Array.prototype[Symbol.iterator]; Array.prototype[Symbol.iterator] = function () { self.poisoned += 1; self.where = (self.where || '') + ' iter'; return it.call(this); };
          const sa = Set.prototype.add; Set.prototype.add = function (v) { self.poisoned += 1; self.where = (self.where || '') + ' add'; return sa.call(this, v); };`;
        const b = build();
        const js = b.registrations.get('ads')?.[0]?.js ?? [];
        const sandbox: Record<string, unknown> = { calls: [], location: { hostname: 'example.com', origin: 'https://example.com', ancestorOrigins: [] }, URL };
        sandbox['self'] = sandbox;
        runInNewContext(prelude, sandbox);
        const data = js.filter((p) => !p.endsWith('.main.js'));
        for (const p of data) runInNewContext(b.files.get(p) ?? '', sandbox);
        sandbox['poisoned'] = 0;
        sandbox['where'] = '';
        // The test's recorder (`record` in FILES) spreads; count only the dispatcher's own calls.
        runInNewContext((b.files.get(js.at(-1) ?? '') ?? '').replace('self.calls.push([name,...args])', 'self.calls.push([name].concat(args))').replaceAll(')(...a)', ').apply(null, a)'), sandbox);
        expect(sandbox['calls']).toHaveLength(1);
        expect(sandbox['where'] ?? '').toBe('');
        expect(sandbox['poisoned']).toBe(0);
      });
    });

    test('the MAIN queue is taken and removed: nothing stays visible to the page', () => {
      const b = buildContent([{ config: { id: 'r', pack: 'ads' }, entries: [entry('example.com##+js(aopr, foo)')] }], ubo, ctx, scriptletPort(lib, ubo, 'c'));
      const js = b.registrations.get('ads')?.[0]?.js ?? [];
      const sandbox: Record<string, unknown> = { calls: [], location: { hostname: 'example.com', ancestorOrigins: [] }, URL };
      sandbox['self'] = sandbox;
      for (const p of js) runInNewContext(b.files.get(p) ?? '', sandbox);
      expect('__sl_q' in sandbox).toBe(false);
      expect(sandbox['calls']).toEqual([['abort-on-property-read', 'foo']]);
    });
  });
});
