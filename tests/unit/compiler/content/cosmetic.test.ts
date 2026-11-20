import { beforeAll, describe, expect, test } from 'vitest';
import { buildContent } from '../../../../compiler/content/build.js';
import { cosmeticFacts } from '../../../../compiler/content/cosmetic.js';
import { resolveHost, isPatternHost } from '../../../../compiler/content/hosts.js';
import { stemIndex } from '../../../../compiler/entities/expand.js';
import { loadVendorLock } from '../../../../compiler/vendor/node-ports.js';
import { loadUboParser, readCompiled, type UboParser } from '../../../../compiler/vendor/ubo.js';
import { verifyContent } from '../../../../compiler/verify/content.js';
import { entry, VENDOR_PRESENT } from './helpers.js';

const ctx = { stems: stemIndex(['google.com', 'google.de', 'www.google.co.uk']) };

describe('hosts as match patterns (P1-27)', () => {
  test.each([
    ['example.com', ['example.com']],
    ['EXAMPLE.com', ['example.com']],
    ['bücher.de', ['xn--bcher-kva.de']],
    ['google.*', ['google.com', 'google.de']],
  ])('%s → %j', (d, hosts) => { expect(resolveHost(d, ctx.stems)).toEqual({ hosts }); });

  test.each(['com', 'co.uk', '1.2.3.4', '/^a\\.b$/', '*', 'a.com/path', 'localhost'])('%s is refused', (d) => {
    expect(resolveHost(d, ctx.stems)).toEqual({ invalid: d });
  });

  test('an entity without an observed host is lost', () => { expect(resolveHost('nowhere.*', ctx.stems)).toEqual({ lost: 'nowhere.*' }); });
  test('isPatternHost re-checks the grammar', () => {
    expect(['a.com', 'xn--bcher-kva.de'].every(isPatternHost)).toBe(true);
    expect(['-a.com', 'a..com', 'a_b.com', 'co.uk', 'a.com:80'].some(isPatternHost)).toBe(false);
  });
});

describe('readCompiled', () => {
  test('plain, style, procedural', () => {
    expect(readCompiled('.a')).toEqual({ kind: 'css', selector: '.a' });
    expect(readCompiled('{"selector":"b","action":["style","x:y"],"cssable":true}')).toEqual({ kind: 'style', selector: 'b', declarations: 'x:y' });
    expect(readCompiled('{"selector":"b","tasks":[["upward",2]]}').kind).toBe('procedural');
    expect(readCompiled('{"selector":"b","action":["remove",""]}').kind).toBe('procedural');
  });
});

describe.skipIf(!VENDOR_PRESENT)('cosmetic filters through uBO\'s compiler (P1-27, P1-28)', () => {
  let ubo: UboParser;
  beforeAll(async () => { ubo = await loadUboParser(await loadVendorLock()); });

  test('specific, style, procedural, exception and negated hosts', () => {
    const facts = (t: string) => cosmeticFacts(entry(t), ubo, ctx).facts.map((f) => `${f.host} ${f.kind} ${f.value}`);
    expect(facts('example.com,~a.example.com##.ad')).toEqual(['example.com h .ad', 'a.example.com u .ad']);
    expect(facts('example.com##body:style(overflow:auto!important)')).toEqual(['example.com s ["body","overflow:auto!important"]']);
    expect(facts('example.com##div:has-text(Sponsored)')[0]).toMatch(/^example.com p \{"selector":"div","tasks":\[\["has-text","Sponsored"\]\]/);
    expect(facts('google.*#@#.ad')).toEqual(['google.com u .ad', 'google.de u .ad']);
  });

  test('refusals are logged with a reason', () => {
    const reason = (t: string) => cosmeticFacts(entry(t), ubo, ctx).log.map((l) => l.reason);
    expect(reason('##.generic')).toEqual(['cosmetic-generic']);
    expect(reason('example.com##a[')).toEqual(['cosmetic-invalid-selector']);
    expect(reason('example.com##body:style(background-image:none !important)')).toEqual(['cosmetic-unsafe']);
    expect(reason('com##.ad')).toEqual(['content-host-invalid']);
    expect(reason('nowhere.*##.ad')).toEqual(['entity-lost']);
  });

  test('a whole build: cross-pack exception fails open, files verify, nothing registered for exception-only packs', () => {
    const b = buildContent([
      { config: { id: 'r1', pack: 'ads' }, entries: [entry('example.com##.ad'), entry('example.com##.keep'), entry('shop.com##div:has-text(x)'), entry('a.com##^script')] },
      { config: { id: 'r2', pack: 'trackers' }, entries: [entry('example.com#@#.ad')] },
    ], ubo, ctx);
    expect(b.stats.failOpenExceptions).toBe(1);
    expect(b.registrations.get('trackers')).toEqual([]);
    expect(b.log.map((l) => l.reason)).toContain('html-filter');
    const files = new Map([...b.files, ['cosmetic/procedural-engine.js', '//']]);
    expect(verifyContent({ files, registrations: b.registrations, defaultPacks: new Set(['ads']) })).toEqual([]);
  });
});
