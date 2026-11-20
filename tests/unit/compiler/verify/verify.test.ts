import { describe, expect, test } from 'vitest';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { rulesetPath } from '../../../../compiler/emit/emit.js';
import { countOracle, likeForLike, OracleFileSchema } from '../../../../compiler/oracle/count.js';
import { sampleOf, snapshotDiff } from '../../../../compiler/verify/snapshot.js';
import { verifyArtefacts } from '../../../../compiler/verify/verify.js';
import { b, built, POPUPS, UBO, UBO_X } from './helpers.js';

describe('verify stage: artefact checks of testing notes §4 (P1-31)', () => {
  test('a good build passes', async () => {
    expect(verifyArtefacts(await built()).failures).toEqual([]);
  });

  test('schema, missing file, ids outside the ledger, duplicate ids', async () => {
    const i = await built();
    const files = new Map(i.files);
    files.set(rulesetPath('easylist'), '[{"id":1,"action":{"type":"block"},"condition":{"x":1}}]');
    files.delete(rulesetPath('cookies'));
    files.set(rulesetPath('urlhaus'), '[{"id":7,"priority":10,"action":{"type":"block"},"condition":{}},{"id":7,"priority":10,"action":{"type":"block"},"condition":{}}]');
    const f = verifyArtefacts({ ...i, files }).failures.join('\n');
    expect(f).toMatch(/easylist: schema/);
    expect(f).toMatch(/cookies: no ruleset file/);
    expect(f).toMatch(/urlhaus: duplicate rule ids/);
    expect(f).toMatch(/urlhaus: id 7 is not in the ledger/);
  });

  test('purity, redirect invariant, priority bands, unchecked regex', async () => {
    const swapped = await built({ ubo: [...UBO, ...UBO_X], uboX: [] });
    expect(verifyArtefacts(swapped).failures.join('\n')).toMatch(/ubo: redirect rule \d+ in a safe file/);
    const uncovered = await built({ ubo: UBO.slice(1) });
    expect(verifyArtefacts(uncovered).failures).toContain('ubo-x: 1 redirect(s) without a covering block');
    const lowStock = await built({ ubo: [...UBO, b({ priority: 3, action: { type: 'allow' }, condition: { urlFilter: '||z.example^' } })] });
    expect(verifyArtefacts(lowStock).failures).toContain('ubo: 1 rule(s) outside the stock priority band');
    const i = await built();
    expect(verifyArtefacts({ ...i, regexResults: {} }).failures).toContain('1 regex rule(s) without a supported Chromium result');
  });

  test('pop-up artefacts: band, main_frame only, host-anchored, destinations covered', async () => {
    const generic = await built({ popups: [...POPUPS, b({ priority: 1, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], urlFilter: '/aff?' } })] });
    expect(verifyArtefacts(generic).failures).toContain('popups: 1 rule(s) not block/allow on main_frame with a host-anchored URL');
    const band = await built({ popups: [b({ priority: 2, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], requestDomains: ['pop.example'] } })] });
    expect(verifyArtefacts(band).failures).toContain('popups: 1 rule(s) outside the pop-up priority band');
    const tld = await built({ popups: [b({ priority: 1, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], requestDomains: ['com'] } })], destinations: ['com'] });
    expect(verifyArtefacts(tld).failures.join('\n')).toMatch(/2 host\(s\) that are not site hosts/);
    const extra = await built({ destinations: ['pop.example', 'other.example'] });
    expect(verifyArtefacts(extra).failures).toContain('popup-destinations.json: 1 host(s) not covered by popups');
  });

  test('P2-43 (T7): a stock rule may not allow everything, allow a whole suffix, or block navigations to one', async () => {
    const P = 110;
    const bad = [
      b({ priority: P, action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['main_frame'], urlFilter: '*' } }),
      b({ priority: P, action: { type: 'allow' }, condition: { urlFilter: '||com^' } }),
      b({ priority: P, action: { type: 'allow' }, condition: { domainType: 'thirdParty' } }),
      b({ priority: P, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], urlFilter: '||co.uk^' } }),
      b({ priority: P, action: { type: 'block' }, condition: { resourceTypes: ['main_frame', 'script'], requestDomains: ['com'] } }),
      b({ priority: P, action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['main_frame'], initiatorDomains: ['com'] } }),
    ];
    const f = verifyArtefacts(await built({ ubo: [...UBO, ...bad] })).failures.join('\n');
    expect(f).toMatch(/ubo: 6 rule\(s\) allow every host or a whole suffix, or block navigations to one/);
    const fine = [
      b({ priority: P, action: { type: 'allow' }, condition: { urlFilter: '/wp-content/plugins/x.js' } }),
      b({ priority: P, action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['main_frame'], urlFilter: '||site.example^' } }),
      b({ priority: P, action: { type: 'allow' }, condition: { initiatorDomains: ['site.example'] } }),
      b({ priority: P, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], requestDomains: ['top'], urlFilter: '&p=*&_mi|' } }),
      b({ priority: P, action: { type: 'block' }, condition: { resourceTypes: ['ping'], domainType: 'thirdParty', urlFilter: '*' } }),
      b({ priority: P, action: { type: 'block' }, condition: { resourceTypes: ['script'], requestDomains: ['undefined', 'ads.example'] } }),
    ];
    expect(verifyArtefacts(await built({ ubo: [...UBO, ...fine] })).failures).toEqual([]);
  });

  test('catalog: invalid, a slot missing, ceilings exceeded', async () => {
    const i = await built();
    const files = new Map(i.files);
    files.set('catalog.json', '{"schema":2}');
    expect(verifyArtefacts({ ...i, files }).failures.some((f) => f.startsWith('catalog:'))).toBe(true);
    const catalog = JSON.parse(i.files.get('catalog.json') ?? '{}') as { rulesets: Record<string, { maxRules: number }> };
    const tight = { ...catalog, rulesets: { ...catalog.rulesets, ubo: { ...catalog.rulesets['ubo'], maxRules: 1 } } };
    const withoutX = Object.fromEntries(Object.entries(tight.rulesets).filter(([k]) => k !== 'ubo-x'));
    files.set('catalog.json', JSON.stringify(tight));
    expect(verifyArtefacts({ ...i, files }).failures).toContain('ubo: 2 / 1 over the catalog ceiling');
    files.set('catalog.json', JSON.stringify({ ...tight, rulesets: withoutX, packs: Object.fromEntries(Object.entries((tight as unknown as { packs: Record<string, { rulesets: string[] }> }).packs)
      .map(([k, p]) => [k, { ...p, rulesets: p.rulesets.filter((r) => r !== 'ubo-x') }])) }));
    expect(verifyArtefacts({ ...i, files }).failures).toContain('catalog misses slot ubo-x');
  });
});

describe('count oracle (filter-pipeline notes §11)', () => {
  const oracle = OracleFileSchema.parse({ schema: 1, ubol: 'x', chromium: 'c', rulesets: {
    ubo: { ubolId: 'ublock-filters', rules: 100, regex: 50, regexValid: 40 }, urlhaus: { ubolId: 'u', rules: 1, regex: 0, regexValid: 0 } }, popups: { ubo: 100 } });
  const t = { rulesMin: -0.15, rulesMax: 0.4, regexMax: 0.2, failFactor: 2 };
  const rules = (n: number, regex = 0, mainFrame = 0): DnrRule[] => [
    ...Array.from({ length: n - regex - mainFrame }, (_, i) => ({ id: i + 1, action: { type: 'block' as const }, condition: {} })),
    ...Array.from({ length: regex }, (_, i) => ({ id: 1000 + i, action: { type: 'block' as const }, condition: { regexFilter: 'a' } })),
    ...Array.from({ length: mainFrame }, (_, i) => ({ id: 2000 + i, action: { type: 'block' as const }, condition: { resourceTypes: ['main_frame' as const], regexFilter: 'b' } })),
  ];

  test('like-for-like leaves main_frame-only rules out', () => {
    expect(likeForLike(rules(130, 40, 20))).toEqual({ rules: 110, regex: 40 });
  });

  test('ok inside the tolerance, warn outside, fail at twice; tiny counts by difference; pop-up filters', () => {
    const verdicts = (n: number, regex: number, pop: number) => countOracle(oracle, new Map([['ubo', rules(n, regex)], ['urlhaus', rules(12)]]), new Map([['ubo', pop]]), t)
      .map((r) => `${r.what}:${r.verdict}`);
    expect(verdicts(120, 44, 110)).toEqual(['ubo rules:ok', 'ubo regex:ok', 'urlhaus rules:ok', 'urlhaus regex:ok', 'popups from ubo:ok']);
    expect(verdicts(150, 54, 79)).toEqual(['ubo rules:warn', 'ubo regex:warn', 'urlhaus rules:ok', 'urlhaus regex:ok', 'popups from ubo:warn']);
    expect(verdicts(181, 57, 69)).toEqual(['ubo rules:fail', 'ubo regex:fail', 'urlhaus rules:ok', 'urlhaus regex:ok', 'popups from ubo:fail']);
  });
});

describe('snapshot oracle', () => {
  test('counts, bytes and a sample of up to 200 rules found again unchanged', () => {
    const many = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, action: { type: 'block' as const }, condition: { urlFilter: `||h${String(i)}.example^` } }));
    expect(sampleOf(many)).toHaveLength(150);
    const before = new Map([['ubo', JSON.stringify(many)], ['gone', '[]']]);
    const after = new Map([['ubo', JSON.stringify(many.map((r) => (r.id === 1 ? { ...r, priority: 99 } : r)).slice(0, 400))]]);
    const [gone, ubo] = snapshotDiff(before, after);
    expect(gone).toMatchObject({ slot: 'gone', rulesBefore: 0, rulesAfter: 0 });
    expect(ubo).toMatchObject({ slot: 'ubo', rulesBefore: 450, rulesAfter: 400, sampled: 150 });
    expect(ubo?.unchanged).toBe(150 - 1 - 16);
  });
});
