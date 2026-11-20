import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadListsConfig, parseJsonWith } from '../../../../compiler/config/load.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { ALLOW_BUCKET, bucketIndexOf } from '../../../../compiler/emit/buckets.js';
import { emitBuild, manifestFragment, rulesetPath, type EmitInput } from '../../../../compiler/emit/emit.js';
import { EntitiesSchema } from '../../../../compiler/entities/schema.js';
import { slotsOf } from '../../../../compiler/postpass/budgets.js';
import type { BucketedRule } from '../../../../compiler/postpass/coalesce.js';
import { readCatalog } from '../../../../src/core/catalog/read.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const entities = parseJsonWith(EntitiesSchema, readFileSync(`${ROOT}lists/entities.json`, 'utf8'), 'entities');
const src = (line: number) => ({ text: 't', source: { list: 'easylist', line, text: `f${String(line)}` }, fixes: [] });
const b = (id: number, bucket: string, condition: DnrRule['condition'] = { urlFilter: `||h${String(id)}.example^` }): BucketedRule =>
  ({ rule: { id, priority: 10, action: { type: 'block' }, condition }, sources: [src(id)], bucket });

async function input(): Promise<EmitInput> {
  const config = await loadListsConfig(`${ROOT}lists/lists.config.json`);
  const rules = new Map([['ubo', [b(3, 'google'), b(1, 'google'), b(2, 'google'), b(4, 'other:ads'), b(6, 'meta')]], ['popups', [b(1, 'other:popup')]]]);
  return { config, slots: slotsOf(config), rules, entities, destinations: ['a.example'], lifted: { ubo: ['a.example'] }, strictSites: ['s.example'],
    log: [{ source: { list: 'ubo-filters', line: 9, text: 'x' }, reason: 'badfilter' }, { source: { list: 'easylist', line: 2, text: 'y' }, reason: 'ubo-cname' }] };
}

describe('emit (P1-26)', () => {
  test('36 ruleset files, sorted by id, minified, plus catalog, buckets and pop-up lists', async () => {
    const out = emitBuild(await input());
    const rulesets = [...out.shipped.keys()].filter((p) => p.startsWith('rulesets/'));
    expect(rulesets).toHaveLength(36);
    expect((JSON.parse(out.shipped.get(rulesetPath('ubo')) ?? '[]') as DnrRule[]).map((r) => r.id)).toEqual([1, 2, 3, 4, 6]);
    expect(out.shipped.get(rulesetPath('cookies'))).toBe('[]');
    expect(out.shipped.get('popup-destinations.json')).toBe('["a.example"]');
    expect(out.shipped.get('popup-strict-sites.json')).toBe('["s.example"]');
    expect(out.shipped.get('popup-lifted.json')).toBe('{"ubo":["a.example"]}');
    expect(out.counts.get('ubo')).toMatchObject({ rules: 5, regex: 0 });
  });

  test('deterministic bytes', async () => {
    const [one, two] = [emitBuild(await input()), emitBuild(await input())];
    expect([...one.shipped]).toEqual([...two.shipped]);
    expect([...one.debug]).toEqual([...two.debug]);
  });

  test('catalog passes the worker\'s reader; -x slots need host access; packs list their slots', async () => {
    const out = emitBuild(await input());
    const read = readCatalog(JSON.parse(out.shipped.get('catalog.json') ?? '{}'));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.rulesets['ubo-x' as never]).toEqual({ needsHostAccess: true, maxRules: 1100, maxRegex: 40 });
    expect(read.value.packs['ads' as never]?.rulesets).toEqual(['ubo', 'ubo-x', 'easylist', 'easylist-x']);
    expect(read.value.packs['popups' as never]).toMatchObject({ rulesets: ['popups'], default: true, licence: 'cleared' });
    expect(Object.keys(read.value.rulesets)).toHaveLength(36);
  });

  test('buckets.json: runs resolve every id; ids above the packaged ones resolve to none', async () => {
    const out = emitBuild(await input());
    const text = out.shipped.get('buckets.json') ?? '';
    const v = JSON.parse(text) as { buckets: { id: string; name: string; category: string }[]; rulesets: Record<string, [number, number][]> };
    const runs = v.rulesets['ubo'] ?? [];
    const name = (id: number) => v.buckets[bucketIndexOf(runs, id)]?.name;
    expect([1, 2, 3].map(name)).toEqual(['Google', 'Google', 'Google']);
    expect(v.buckets[bucketIndexOf(runs, 4)]).toEqual({ id: 'other:ads', name: 'Other', category: 'ads' });
    expect(name(6)).toBe('Meta');
    expect(bucketIndexOf(runs, 7)).toBe(-1);
    expect(bucketIndexOf(runs, 0)).toBe(-1);
    expect(gunzipSync(gzipSync(text)).toString()).toBe(text);
  });

  test('buckets.json marks exception rules with the reserved index -2 (privacy panel never counts them)', async () => {
    const base = await input();
    const allow = (id: number, type: 'allow' | 'allowAllRequests'): BucketedRule => ({ ...b(id, 'google'), rule: { ...b(id, 'google').rule, action: { type } } });
    const rules = new Map([...base.rules, ['ubo', [b(1, 'google'), allow(2, 'allow'), allow(3, 'allowAllRequests'), b(4, 'google')]]]);
    const out = emitBuild({ ...base, rules });
    const v = JSON.parse(out.shipped.get('buckets.json') ?? '{}') as { buckets: { id: string }[]; rulesets: Record<string, [number, number][]> };
    const runs = v.rulesets['ubo'] ?? [];
    expect([1, 2, 3, 4].map((id) => bucketIndexOf(runs, id))).toEqual([0, ALLOW_BUCKET, ALLOW_BUCKET, 0].map((i) => (i === 0 ? v.buckets.findIndex((x) => x.id === 'google') : i)));
  });

  test('manifest fragment: default safe slots on, every -x off, other packs off', async () => {
    const { slots } = await input();
    const rr = (manifestFragment(slots) as { declarative_net_request: { rule_resources: { id: string; enabled: boolean; path: string }[] } })
      .declarative_net_request.rule_resources;
    expect(rr.filter((r) => r.enabled).map((r) => r.id)).toEqual(['ubo', 'easylist', 'easyprivacy', 'badware', 'urlhaus', 'popups']);
    expect(rr.filter((r) => r.id.endsWith('-x')).every((r) => !r.enabled)).toBe(true);
    expect(rr[0]?.path).toBe('rulesets/ubo.json');
  });

  test('debug artefacts: id map per non-empty slot, sorted log; nothing of them is shipped', async () => {
    const out = emitBuild(await input());
    expect((JSON.parse(out.debug.get('debug/idmap/ubo.json') ?? '{}') as Record<string, unknown>)['6']).toEqual([{ list: 'easylist', line: 6, text: 'f6' }]);
    expect(out.debug.has('debug/idmap/cookies.json')).toBe(false);
    expect((JSON.parse(out.debug.get('log.json') ?? '[]') as { list: string }[]).map((l) => l.list)).toEqual(['easylist', 'ubo-filters']);
    expect([...out.shipped.keys()].some((k) => k.startsWith('debug/') || k === 'log.json')).toBe(false);
  });

  test('an unknown key in an emitted rule fails the build', async () => {
    const base = await input();
    const odd = { ...b(1, 'google'), rule: { ...b(1, 'google').rule, condition: { x_src: 1 } } } as unknown as BucketedRule;
    expect(() => emitBuild({ ...base, rules: new Map([['ubo', [odd]]]) })).toThrow(/ubo rule 1/);
  });
});
