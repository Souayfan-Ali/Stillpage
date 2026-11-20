import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { runBuild, type BuildInputs } from '../../../../compiler/build/pipeline.js';
import { loadListsConfig, parseJsonWith } from '../../../../compiler/config/load.js';
import { RESOURCE_TYPES, type DnrRule } from '../../../../compiler/dnr/schema.js';
import { rulesetPath } from '../../../../compiler/emit/emit.js';
import { EntitiesSchema } from '../../../../compiler/entities/schema.js';
import { emptyRegexCache, type RegexChecker } from '../../../../compiler/validate/regex.js';
import { loadVendorLock } from '../../../../compiler/vendor/node-ports.js';
import { loadUboParser } from '../../../../compiler/vendor/ubo.js';
import { PROCEDURAL_ENGINE } from '../../../../src/core/content/files.js';
import { VENDOR_PRESENT } from '../content/helpers.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const entities = parseJsonWith(EntitiesSchema, readFileSync(`${ROOT}lists/entities.json`, 'utf8'), 'entities');
/** Fake Chromium: refuses regexes with a lookahead. */
const checker: RegexChecker = { id: 'fake', check: (qs) => Promise.resolve(qs.map((q) => ({ isSupported: !q.regex.includes('(?=') }))) };

const LISTS: Readonly<Record<string, string>> = {
  'ubo-filters': ['||ads.example^', '||doubleclick.net^$third-party', '||a.example/ad.js$script,redirect=noopjs', '/^https:\\/\\/x(?=y)/$script',
    '||pop.example^$popup', '@@||ok.example^$popup', '*$popup,3p,domain=strict.example', '/aff?$popup', '||c.example^$cname'].join('\n'),
  easylist: '||banner.example^\n||adnxs.com^$third-party\n||popads.net^$popup',
  easyprivacy: '||track.example^$third-party',
  'ubo-badware': '||bad.example^$doc',
  urlhaus: '0.0.0.0 malware.example',
};

async function inputs(): Promise<BuildInputs> {
  const config = await loadListsConfig(`${ROOT}lists/lists.config.json`);
  const texts = new Map(config.lists.map((l) => [l.id, LISTS[l.id] ?? '']));
  return { config, texts, entities, ledgers: new Map(), regexCache: emptyRegexCache('fake') };
}

describe('runBuild (P1-32)', () => {
  test('compiles, validates, assigns ids and emits every artefact', async () => {
    const r = await runBuild(await inputs(), checker);
    const rules = (slot: string) => JSON.parse(r.emit.shipped.get(rulesetPath(slot)) ?? '[]') as DnrRule[];
    expect(rules('ubo').map((x) => x.action.type).sort()).toEqual(['block', 'block', 'block']);
    expect(rules('ubo-x').map((x) => x.action.type)).toEqual(['redirect']);
    expect(rules('popups').map((x) => x.priority).sort()).toEqual([1, 1, 3]);
    expect(JSON.parse(r.emit.shipped.get('popup-destinations.json') ?? '[]')).toEqual(['pop.example', 'popads.net']);
    expect(JSON.parse(r.emit.shipped.get('popup-strict-sites.json') ?? '[]')).toEqual(['strict.example']);
    expect(r.report.rejections).toMatchObject({ 'regex-unsupported': 1, 'ubo-cname': 1, 'popup-generic-pattern': 1 });
    expect(r.report.popups).toMatchObject({ filters: 5, rule: 3, strict: 1, log: 1, bySource: { ubo: 4, easylist: 1 } });
    expect(r.report.regex).toEqual({ distinct: 1, askedChromium: 1 });
    expect(Object.values(r.regexResults)).toEqual([false]);
    expect(r.ledgers.get('ubo')?.nextId).toBe(4);
    expect(r.growth).toEqual([]);
  });

  test('a second build with the ledgers and cache of the first gives the same bytes and asks Chromium nothing', async () => {
    const first = await runBuild(await inputs(), checker);
    const second = await runBuild({ ...(await inputs()), ledgers: first.ledgers, regexCache: first.regexCache,
      previousCounts: { schema: 1, slots: { ubo: { rules: 1, regex: 0 } } } }, checker);
    expect([...second.emit.shipped]).toEqual([...first.emit.shipped]);
    expect(second.report.regex.askedChromium).toBe(0);
    expect(second.growth.map((g) => g.slot)).toContain('ubo');
  });

  test('rules for a slot the config does not declare fail the build', async () => {
    const base = await inputs();
    const config = { ...base.config, rulesets: base.config.rulesets.map((rs) => (rs.id === 'ubo' ? { ...rs, slots: { safe: rs.slots.safe } } : rs)) };
    await expect(runBuild({ ...base, config }, checker)).rejects.toThrow(/"ubo-x", which is not a declared slot/);
  });
});

describe.skipIf(!VENDOR_PRESENT)('runBuild with the content emitters (P1-27, P1-28)', () => {
  test('emits shard files, the engine only when used, registrations in the debug tree, and counts in the report', async () => {
    const base = await inputs();
    const texts = new Map(base.texts);
    texts.set('ubo-filters', `${LISTS['ubo-filters'] ?? ''}\nexample.com##.ad\nshop.example##div:has-text(Sponsored)\n##.generic`);
    const ubo = await loadUboParser(await loadVendorLock());
    const r = await runBuild({ ...base, texts, content: { ubo, engine: '/* engine */' } }, checker);
    expect(r.emit.shipped.get(PROCEDURAL_ENGINE)).toBe('/* engine */');
    // A plain-lane and a code-lane shard (D-41: the procedural host is sharded apart) plus the generic data (P2-23).
    expect([...r.emit.shipped.keys()].filter((k) => k.startsWith('cosmetic/ads/')).sort()).toEqual(['cosmetic/ads/0.js', 'cosmetic/ads/1.js', 'cosmetic/ads/generic.js']);
    expect(r.report.content.patterns).toMatchObject({ default: 2, all: 2 });
    expect(r.report.rejections['cosmetic-generic']).toBeUndefined();
    expect(r.report.content.generic?.['ads']).toMatchObject({ selectors: 1 });
    // D-41: registered script bytes of the default registrations, each registration's files counted (summed) and once (unique).
    expect(r.report.content.scriptBytes).toMatchObject({ max: 10_000_000 });
    expect(r.report.content.scriptBytes?.summed).toBeGreaterThanOrEqual(r.report.content.scriptBytes?.unique ?? Infinity);
    const catalog = JSON.parse(r.emit.shipped.get('catalog.json') ?? '{}') as { packs: Record<string, { registrations: unknown[] }> };
    expect(catalog.packs['ads']?.registrations).toBeUndefined();
    const shipped = JSON.parse(r.emit.shipped.get('registrations.json') ?? '{}') as { packs: Record<string, { hosts: string[] }[]> };
    expect(shipped.packs['ads']?.flatMap((x) => x.hosts).sort()).toEqual(['example.com', 'shop.example']);
    expect(Object.keys(JSON.parse(r.emit.debug.get('registrations.json') ?? '{}') as object)).toContain('ads');
  });
});

describe('$badfilter scope (P2-27, design review 2026-11-14)', () => {
  test('a default list cancels everywhere; an optional pack cancels only inside its own pack, and is logged when it reaches out', async () => {
    const base = await inputs();
    const texts = new Map(base.texts);
    texts.set('easylist', '||banner.example^\n||adnxs.com^$third-party\n||cookie.example^');
    texts.set('easylist-cookies', '||cookie.example^$badfilter\n||banner.example^$badfilter\n||consent.example^');
    texts.set('ubo-annoyances-cookies', '||consent.example^$badfilter');
    texts.set('easylist-social', '||cookie.example^');
    texts.set('ubo-unbreak', '||adnxs.com^$third-party,badfilter');
    const r = await runBuild({ ...base, texts }, checker);
    const domains = (slot: string): string[] =>
      (JSON.parse(r.emit.shipped.get(rulesetPath(slot)) ?? '[]') as DnrRule[]).flatMap((x) => x.condition.requestDomains ?? [(x.condition.urlFilter ?? '').replace(/^\|\||\^$/g, '')]);
    // Default pack's badfilter: build-wide.
    expect(domains('easylist')).not.toContain('adnxs.com');
    // Optional pack's badfilters do not reach the default or another optional pack…
    expect(domains('easylist')).toEqual(expect.arrayContaining(['banner.example', 'cookie.example']));
    expect(domains('annoy-social')).toContain('cookie.example');
    // …but work inside their own pack (across its lists).
    expect(domains('cookies')).not.toContain('consent.example');
    expect(r.report.rejections['badfilter-outside-pack']).toBe(2);
  });
});

describe('GPC (P2-31)', () => {
  test('gpc-x is our one built-in rule: Sec-GPC: 1 on every resource type, lowest stock priority', async () => {
    const r = await runBuild(await inputs(), checker);
    const rules = JSON.parse(r.emit.shipped.get(rulesetPath('gpc-x')) ?? '[]') as DnrRule[];
    expect(rules).toEqual([{
      id: 1,
      priority: 10,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Sec-GPC', operation: 'set', value: '1' }] },
      condition: { resourceTypes: [...RESOURCE_TYPES] },
    }]);
  });
});
