/**
 * Content checks of the verify stage (testing notes §4, P1-27…P1-29), one failure at a time: registration
 * hosts, ids and files, the layout rule, each shard data file read back, common tables and budgets.
 */
import { describe, expect, test } from 'vitest';
import { readShardFile, verifyContent, type ContentVerifyInput } from '../../../../compiler/verify/content.js';
import type { CatalogRegistration } from '../../../../src/core/catalog/registrations.js';
import { commonDataPath } from '../../../../src/core/content/files.js';
import { shardFileWrap } from '../../../../src/core/content/shard-data.js';
import type { Hostname } from '../../../../src/core/ids.js';
import { MAX_SHARD_BYTES, REGISTRATION_BUDGET } from '../../../../src/core/limits.js';

type World = 'ISOLATED' | 'MAIN';

const wrap = (o: unknown, world: World = 'ISOLATED'): string => {
  const w = shardFileWrap(world);
  return `${w.prefix}${JSON.stringify(o)}${w.suffix}`;
};
const shard = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ v: 1, pack: 'ads', shard: 0, hosts: ['a.com'], entries: [{ h: [0] }], selectors: ['.x'], styles: [], procedural: [], invocations: [], ...over });
const reg = (id: string, hosts: readonly string[], js: readonly string[] = ['cosmetic/ads/0.js'], world: World = 'ISOLATED'): CatalogRegistration =>
  ({ id, world, js, hosts: hosts as Hostname[] });

/** One `ads` pack with the given registrations and files (the shard file present by default). */
function input(regs: readonly CatalogRegistration[], files: Readonly<Record<string, string>> = { 'cosmetic/ads/0.js': wrap(shard()) }): ContentVerifyInput {
  return { files: new Map(Object.entries(files)), registrations: new Map([['ads', regs]]), defaultPacks: new Set(['ads']) };
}

describe('verifyContent: registrations', () => {
  test('a well-formed pack passes', () => {
    expect(verifyContent(input([reg('iso:ads:0', ['a.com'])]))).toEqual([]);
  });

  test('hosts that are not match-pattern hosts are counted with examples', () => {
    expect(verifyContent(input([reg('iso:ads:0', ['a.com', 'co.uk', 'Bad Host'])]))).toContain('2 registration host(s) are not valid match-pattern hosts (e.g. co.uk, Bad Host)');
  });

  test('two registrations with one id fail', () => {
    expect(verifyContent(input([reg('iso:ads:0', ['a.com']), reg('iso:ads:0', ['b.com'])]))).toContain('duplicate registration ids');
  });

  test('a listed file that is neither packaged nor a runtime script fails; runtime scripts need no file', () => {
    const problems = verifyContent(input([reg('iso:ads:0', ['a.com'], ['cosmetic/ads/0.js', 'gone.js', 'cosmetic-specific.js'])]));
    expect(problems).toEqual(['a registration lists gone.js, which is not packaged']);
  });

  test('a shard listed but not packaged is reported once, without a data check', () => {
    expect(verifyContent(input([reg('iso:ads:0', ['a.com'])], {}))).toEqual(['a registration lists cosmetic/ads/0.js, which is not packaged']);
  });
});

describe('verifyContent: layout rule', () => {
  test('a host in two registrations of one world fails', () => {
    const problems = verifyContent(input([reg('iso:ads:0', ['a.com']), reg('iso:ads:1', ['a.com'])]));
    expect(problems).toContain('ads ISOLATED: 1 host(s) in more than one registration');
  });

  test('a host under a listed parent fails, naming an example', () => {
    const problems = verifyContent(input([reg('iso:ads:0', ['a.com', 'x.a.com'])]));
    expect(problems).toContain('ads ISOLATED: 1 host(s) listed under a listed parent (e.g. x.a.com)');
  });

  test('the same host in each world is allowed', () => {
    const main = wrap(shard({ selectors: [], entries: [{}] }), 'MAIN');
    const regs = [reg('iso:ads:0', ['a.com']), reg('main:ads:0', ['a.com'], ['scriptlets/ads/main/0.js'], 'MAIN')];
    expect(verifyContent(input(regs, { 'cosmetic/ads/0.js': wrap(shard()), 'scriptlets/ads/main/0.js': main }))).toEqual([]);
  });
});

describe('verifyContent: shard data files', () => {
  const one = (text: string): readonly string[] => verifyContent(input([reg('iso:ads:0', ['a.com'])], { 'cosmetic/ads/0.js': text }));

  test('a file that is not a shard data file', () => {
    expect(one('not data')).toEqual(['cosmetic/ads/0.js: not a shard data file']);
  });

  test('a shard over the size budget', () => {
    const big = wrap(shard({ selectors: [`.${'x'.repeat(MAX_SHARD_BYTES)}`] }));
    expect(one(big).join('\n')).toMatch(/cosmetic\/ads\/0\.js: \d+ B > 65536/);
  });

  test('a selector the sanitiser refuses', () => {
    expect(one(wrap(shard({ selectors: ['@media x'] })))).toEqual(['cosmetic/ads/0.js: 1 selector(s) or style(s) the sanitiser refuses']);
  });

  test('a style whose selector or declaration the sanitiser refuses', () => {
    const styles = [['@x', 'color: red'], ['.y', 'not a declaration']];
    expect(one(wrap(shard({ styles, entries: [{ s: [0, 1] }] })))).toEqual(['cosmetic/ads/0.js: 2 selector(s) or style(s) the sanitiser refuses']);
  });

  test('a shard host that is a hostname but not a pattern host', () => {
    expect(one(wrap(shard({ hosts: ['co.uk'] })))).toEqual(['cosmetic/ads/0.js: a host that is not a pattern host']);
  });

  test('negative scriptlet indices are bounded by the pack common table, absent or malformed counting as empty', () => {
    const data = wrap(shard({ selectors: [], entries: [{ j: [-1] }] }), 'MAIN');
    const regs = [reg('main:ads:0', ['a.com'], ['scriptlets/ads/main/0.js'], 'MAIN')];
    const common = (text: string): readonly string[] => verifyContent(input(regs, { 'scriptlets/ads/main/0.js': data, [commonDataPath('ads', 'MAIN')]: text }));
    const table = wrap({ v: 1, pack: 'ads', common: true, invocations: [[0]] }, 'MAIN');
    expect(common(table)).toEqual([]);
    expect(common('broken')).toContain('scriptlets/ads/main/0.js: not a shard data file');
    expect(verifyContent(input(regs, { 'scriptlets/ads/main/0.js': data }))).toEqual(['scriptlets/ads/main/0.js: not a shard data file']);
  });
});

describe('readShardFile', () => {
  test('a wrapper around text that is not JSON is refused', () => {
    const w = shardFileWrap('ISOLATED');
    expect(readShardFile(`${w.prefix}{oops${w.suffix}`, 'ISOLATED')).toBeNull();
  });

  test('a file in the other world wrapper is refused', () => {
    expect(readShardFile(wrap(shard(), 'MAIN'), 'ISOLATED')).toBeNull();
  });

  test('the first-shard wrapper is accepted', () => {
    const w = shardFileWrap('MAIN', true);
    expect(readShardFile(`${w.prefix}${JSON.stringify(shard())}${w.suffix}`, 'MAIN')?.hosts).toEqual(['a.com']);
  });
});

describe('verifyContent: common tables and budgets', () => {
  test('an ISOLATED common table over the size budget fails while still well-formed', () => {
    const big = wrap({ v: 1, pack: 'ads', common: true, invocations: [[0, 'x'.repeat(MAX_SHARD_BYTES)]] });
    const problems = verifyContent(input([], { [commonDataPath('ads', 'ISOLATED')]: big }));
    expect(problems.join('\n')).toMatch(/scriptlets\/ads\/isolated\/common\.js: \d+ B > 65536/);
    expect(problems.join('\n')).not.toMatch(/not a common table/);
  });

  test('fixed registrations count against the registration budget', () => {
    const at = { ...input([]), fixed: { patterns: 0, registrations: REGISTRATION_BUDGET + 1 } };
    expect(verifyContent(at)).toContain(`${String(REGISTRATION_BUDGET + 1)} registrations > ${String(REGISTRATION_BUDGET)}`);
  });

  test('regional packs are passed to the pattern budget on their own line', () => {
    const hosts = Array.from({ length: 6_001 }, (_, n) => `h${String(n)}.com`);
    const i = { ...input([]), registrations: new Map([['reg-de', [reg('iso:reg-de:0', hosts, ['x.js'])]]]), files: new Map([['x.js', '//']]), regionalPacks: new Set(['reg-de']) };
    expect(verifyContent(i)).toContain('reg-de: 6001 match patterns > 6000');
  });
});
