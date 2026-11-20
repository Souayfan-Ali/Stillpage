import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { compileNetwork, parseAll } from '../../../../compiler/build/network.js';
import { loadListsConfig } from '../../../../compiler/config/load.js';
import { checkOverrides, deadBadfilters, overrideEntries, parseOverrides, type OverrideEntry } from '../../../../compiler/overrides/overrides.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const TODAY = '2026-11-14';
const RULESETS = new Set(['ubo', 'easylist']);

const entry = (over: Partial<OverrideEntry> = {}): OverrideEntry => ({
  id: 'unbreak-shop', kind: 'network', ruleset: 'easylist', filter: '@@||cdn.shop.example^$script',
  reason: 'checkout breaks', owner: 'maintainer', link: 'https://github.com/example/uAssets/issues/1',
  added: '2026-11-10', expires: '2027-01-10', ...over,
});
const file = (...entries: OverrideEntry[]) => ({ schema: 1 as const, entries });
const check = (...entries: OverrideEntry[]) => checkOverrides(file(...entries), { today: TODAY, rulesets: RULESETS });

describe('overrides: dated entries with owner and link (update-strategy notes §8, P2-08)', () => {
  test('a valid exception or $badfilter passes', () => {
    expect(check(entry(), entry({ id: 'bf', filter: '||ads.example^$badfilter', ruleset: 'ubo' }))).toEqual({ errors: [], warnings: [] });
  });

  test('an expired entry fails, and is never dropped silently', () => {
    expect(check(entry({ expires: '2026-11-13' })).errors).toEqual(['unbreak-shop: expired on 2026-11-13']);
    expect(check(entry({ expires: TODAY })).errors).toEqual([]);
  });

  test('warns from 14 days before expiry', () => {
    expect(check(entry({ expires: '2026-11-27' })).warnings).toEqual(['unbreak-shop: expires on 2026-11-27 (renew or remove it)']);
    expect(check(entry({ expires: '2026-11-29' })).warnings).toEqual([]);
  });

  test('at most 90 days from added to expires, and expires not before added', () => {
    expect(check(entry({ added: '2026-11-01', expires: '2027-01-31' })).errors).toEqual(['unbreak-shop: lives 91 days (at most 90; renew by a reviewed change)']);
    expect(check(entry({ added: '2026-11-01', expires: '2027-01-30' })).errors).toEqual([]);
    expect(check(entry({ added: '2026-11-20', expires: '2026-11-19' })).errors).toContain('unbreak-shop: expires before it was added');
  });

  test('only loosens: a block rule, a cosmetic filter or a second line is refused', () => {
    expect(check(entry({ filter: '||cdn.shop.example^' })).errors).toEqual(['unbreak-shop: a network override must be an exception (@@) or $badfilter']);
    expect(check(entry({ filter: 'shop.example##.ad' })).errors).toEqual(['unbreak-shop: not a network filter (cosmetic and scriptlet overrides are not supported yet)']);
    expect(check(entry({ filter: '@@||a.example^\n||b.example^' })).errors).toEqual(['unbreak-shop: filter must be one line']);
    expect(check(entry({ filter: '! a comment' })).errors).toEqual(['unbreak-shop: not a network filter (cosmetic and scriptlet overrides are not supported yet)']);
  });

  test('unknown ruleset, duplicate id, and a file that does not match the schema are refused', () => {
    expect(check(entry({ ruleset: 'nope' })).errors).toEqual(['unbreak-shop: unknown ruleset "nope"']);
    expect(check(entry(), entry()).errors).toEqual(['unbreak-shop: id used twice']);
    expect(() => parseOverrides('{"schema":1,"entries":[{"id":"x","kind":"user-origin-css"}]}', 'f')).toThrow();
    expect(() => parseOverrides(JSON.stringify(file(entry({ link: 'http://insecure.example' }))), 'f')).toThrow();
    expect(() => parseOverrides(JSON.stringify(file(entry({ added: '2026-13-01' }))), 'f')).toThrow();
    expect(() => parseOverrides(JSON.stringify(file(entry({ owner: '' }))), 'f')).toThrow();
  });

  test('the committed overrides file is valid and nothing in it has expired (CI fails on an expired entry)', async () => {
    const config = await loadListsConfig(`${ROOT}lists/lists.config.json`);
    const real = parseOverrides(readFileSync(`${ROOT}lists/overrides/overrides.json`, 'utf8'), 'lists/overrides/overrides.json');
    const today = new Date().toISOString().slice(0, 10);
    expect(checkOverrides(real, { today, rulesets: new Set(config.rulesets.map((r) => r.id)) }).errors).toEqual([]);
  });
});

describe('overrides are applied before conversion', () => {
  const LISTS: Readonly<Record<string, string>> = { easylist: '||cdn.shop.example^\n||banner.example^', 'ubo-filters': '||ads.example^\n||keep.example^\n||a.example/ad.js$script,redirect=noopjs' };

  async function compile(entries: readonly OverrideEntry[]) {
    const config = await loadListsConfig(`${ROOT}lists/lists.config.json`);
    const parsed = parseAll(config, new Map(config.lists.map((l) => [l.id, LISTS[l.id] ?? ''])));
    const out = await compileNetwork(config, parsed, () => undefined, undefined, overrideEntries(file(...entries)));
    const rules = (id: string) => out.find((r) => r.config.id === id)?.safe.map((r) => `${r.rule.action.type} ${JSON.stringify(r.rule.condition)}`) ?? [];
    return { rules, parsed, out };
  }

  test('an exception entry becomes an allow rule in its ruleset; a $badfilter removes the upstream filter everywhere', async () => {
    const { rules } = await compile([entry(), entry({ id: 'bf', ruleset: 'ubo', filter: '||ads.example^$badfilter' })]);
    expect(rules('easylist').some((r) => r.startsWith('allow') && r.includes('cdn.shop.example'))).toBe(true);
    expect(rules('ubo').join()).not.toContain('ads.example');
    expect(rules('ubo').join()).toContain('keep.example');
  });

  test('a $badfilter of a redirect filter changes the -x half, which the gate (E5) sends to a full release', async () => {
    const before = await compile([]);
    const after = await compile([entry({ id: 'no-redirect', ruleset: 'ubo', filter: '||a.example/ad.js$script,redirect=noopjs,badfilter' })]);
    const unsafe = (r: typeof before) => r.out.find((x) => x.config.id === 'ubo')?.unsafe.length;
    expect(unsafe(before)).toBe(1);
    expect(unsafe(after)).toBe(0);
  });

  test('no entries, no change', async () => {
    const none = await compile([]);
    const config = await loadListsConfig(`${ROOT}lists/lists.config.json`);
    const plain = await compileNetwork(config, none.parsed, () => undefined);
    expect(none.out.map((r) => r.safe)).toEqual(plain.map((r) => r.safe));
  });

  test('a $badfilter that cancels no upstream filter is reported as dead (warning, not failure)', async () => {
    const entries = [entry({ id: 'dead', ruleset: 'ubo', filter: '||gone.example^$badfilter' }), entry({ id: 'live', ruleset: 'ubo', filter: '||ads.example^$badfilter' })];
    const { parsed } = await compile(entries);
    expect(deadBadfilters(overrideEntries(file(...entries)), [...parsed.values()].flat())).toEqual(['override dead: $badfilter matches no upstream filter (fixed upstream? remove the entry)']);
  });
});
