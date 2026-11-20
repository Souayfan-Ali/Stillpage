import { beforeAll, describe, expect, test } from 'vitest';
import { buildContent } from '../../../../compiler/content/build.js';
import { genericEntry, genericSwitchHost } from '../../../../compiler/content/generic.js';
import { stemIndex } from '../../../../compiler/entities/expand.js';
import { loadVendorLock } from '../../../../compiler/vendor/node-ports.js';
import { loadUboParser, type UboParser } from '../../../../compiler/vendor/ubo.js';
import { verifyContent } from '../../../../compiler/verify/content.js';
import { genericDataPath, genericFileWrap, isGenericData, lookupToken, exceptionsFor, isGenericOff, type GenericData } from '../../../../src/core/generic/data.js';
import type { Hostname } from '../../../../src/core/ids.js';
import { sanitiseSelector } from '../../../../src/core/sanitise/selector.js';
import { entry, VENDOR_PRESENT } from './helpers.js';

const ctx = { stems: stemIndex(['google.com', 'google.de']) };

/** Parses a generic data file back, as the surveyor will. */
function parseGeneric(text: string | undefined): GenericData {
  const { prefix, suffix } = genericFileWrap();
  if (text === undefined || !text.startsWith(prefix) || !text.endsWith(suffix)) throw new Error('not a generic data file');
  const data: unknown = JSON.parse(text.slice(prefix.length, -suffix.length));
  if (!isGenericData(data)) throw new Error('invalid generic data');
  return data;
}

describe('genericSwitchHost', () => {
  test.each([
    ['@@||example.com^$generichide', 'example.com'],
    ['@@||example.com^$ghide', 'example.com'],
    ['@@||example.com^$elemhide', 'example.com'],
    ['@@||example.com^$ehide', 'example.com'],
    ['@@||example.com^$specifichide', null],
    ['@@||example.com/path^$generichide', null],
    ['@@||com^$generichide', null],
  ])('%s → %s', (text, host) => {
    expect(genericSwitchHost(entry(text))).toBe(host);
  });
});

describe.skipIf(!VENDOR_PRESENT)('generic emitter (P2-23)', () => {
  let ubo: UboParser;
  beforeAll(async () => { ubo = await loadUboParser(await loadVendorLock()); });

  test('genericEntry classifies hide, unhide, unsupported and non-generic entries', () => {
    const g = (t: string) => genericEntry(entry(t), ubo, ctx);
    expect(g('##.adsbox')).toMatchObject({ hide: '.adsbox', exceptions: [] });
    expect(g('~example.com##.adsbox')?.exceptions.map((f) => `${f.host} ${f.value}`)).toEqual(['example.com .adsbox']);
    expect(g('#@#.sponsor')).toMatchObject({ unhide: '.sponsor' });
    expect(g('##div:has-text(Sponsored)')?.log.map((l) => [l.reason, l.detail])).toEqual([['cosmetic-generic-unsupported', 'procedural']]);
    expect(g('##body:style(overflow:auto!important)')?.log.map((l) => l.detail)).toEqual(['style']);
    expect(g('##div:has(> .ad-label)')?.log.map((l) => l.detail)).toEqual(['token-less :has()']);
    expect(g('##.ad:has(> img)')).toMatchObject({ hide: '.ad:has(> img)' });
    expect(g('##a[')?.log.map((l) => l.reason)).toEqual(['cosmetic-invalid-selector']);
    expect(g('#@#a[')?.log.map((l) => l.reason)).toEqual(['cosmetic-invalid-selector']);
    expect(g('example.com##.ad')).toBeNull();
    expect(g('example.com#@#.ad')).toBeNull();
  });

  test('a whole build: token map, always list, exceptions, switches, unhide; the data file parses back', () => {
    const b = buildContent([
      { config: { id: 'r1', pack: 'ads' }, entries: [
        entry('##.adsbox'), entry('##div.ad-slot'), entry('###top-ad'), entry('##a[href^="https://ad."]'), entry('##.sponsor'),
        entry('~shop.example##.adsbox'), entry('#@#.sponsor'), entry('example.com##.specific'), entry('##div:has-text(x)'),
      ] },
      { config: { id: 'r2', pack: 'trackers' }, entries: [entry('news.example#@#.adsbox'), entry('@@||nogeneric.example^$generichide'), entry('#@#.adsbox')] },
    ], ubo, ctx);
    const ads = parseGeneric(b.files.get(genericDataPath('ads')));
    expect(ads.selectors).toEqual(['#top-ad', '.adsbox', 'a[href^="https://ad."]', 'div.ad-slot']);
    expect(lookupToken(ads, '.adsbox')).toEqual(['.adsbox']);
    expect(lookupToken(ads, '.ad-slot')).toEqual(['div.ad-slot']);
    expect(lookupToken(ads, '#top-ad')).toEqual(['#top-ad']);
    expect(ads.always.map((i) => ads.selectors[i])).toEqual(['a[href^="https://ad."]']);
    expect(ads.unhide).toEqual(['.sponsor']);
    expect(exceptionsFor(ads, 'shop.example' as Hostname)).toEqual(['.adsbox']);
    expect(exceptionsFor(ads, 'www.news.example' as Hostname)).toEqual(['.adsbox']);
    expect(isGenericOff(ads, 'a.nogeneric.example' as Hostname)).toBe(true);
    // The host-less exception of another pack stays in that pack's `unhide`; it is not applied at build time.
    const trackers = parseGeneric(b.files.get(genericDataPath('trackers')));
    expect(trackers).toMatchObject({ selectors: [], unhide: ['.adsbox'], off: ['nogeneric.example'] });
    expect(b.generic.off).toEqual(['nogeneric.example']);
    expect(b.generic.packs).toEqual({ ads: genericDataPath('ads'), trackers: genericDataPath('trackers') });
    expect(b.stats.generic['ads']).toMatchObject({ selectors: 4, always: 1, unhide: 1, unsupported: 1 });
    expect(b.log.map((l) => l.reason)).not.toContain('cosmetic-switch-unsupported');
    // Generic filters the emitter cannot ship have their own reason code (cores follow-up).
    expect(b.log.map((l) => l.reason)).toContain('cosmetic-generic-unsupported');
    expect(b.log.map((l) => l.reason)).not.toContain('cosmetic-generic');
    for (const s of ads.selectors) expect(sanitiseSelector(s)).toBe(s);
    expect(verifyContent({ files: new Map([...b.files, ['cosmetic/procedural-engine.js', '//']]), registrations: b.registrations, defaultPacks: new Set(['ads']) })).toEqual([]);
  });

  test('a pack without generic filters gets no file; output is deterministic', () => {
    const sources = [{ config: { id: 'r', pack: 'malware' }, entries: [entry('example.com##.x')] }];
    const one = buildContent(sources, ubo, ctx);
    expect(one.files.has(genericDataPath('malware'))).toBe(false);
    expect(one.generic.packs).toEqual({});
    const shuffled = [entry('##.b'), entry('##.a'), entry('##.c > p')];
    const a = buildContent([{ config: { id: 'r', pack: 'ads' }, entries: shuffled }], ubo, ctx);
    const z = buildContent([{ config: { id: 'r', pack: 'ads' }, entries: [...shuffled].reverse() }], ubo, ctx);
    expect(a.files.get(genericDataPath('ads'))).toBe(z.files.get(genericDataPath('ads')));
  });
});
