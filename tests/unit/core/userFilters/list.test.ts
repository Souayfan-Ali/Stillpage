import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import type { Hostname } from '../../../../src/core/ids.js';
import { hiddenSites, selectorsOn, storeOfSites } from '../../../../src/core/userFilters/list.js';
import { UserFilterHostsSchema } from '../../../../src/core/userFilters/schema.js';
import { MAX_HOSTS, MAX_SELECTORS_PER_HOST, type UserFilters } from '../../../../src/core/userFilters/store.js';

const store = (hosts: Readonly<Record<string, readonly string[]>>): UserFilters => ({ v: 1, hosts });

describe('hidden-items list (P2-22)', () => {
  test('selectorsOn: the filters that apply on a host (its own and its parents’, like user-cosmetic), distinct and sorted', () => {
    const s = store({ 'example.com': ['.b', '#a'], 'news.example.com': ['#c', '#a'], 'other.example': ['#d'] });
    expect(selectorsOn(s, 'news.example.com' as Hostname)).toEqual(['#a', '#c', '.b']);
    expect(selectorsOn(s, 'www.example.com' as Hostname)).toEqual(['#a', '.b']);
    expect(selectorsOn(s, 'example.org' as Hostname)).toEqual([]);
    expect(selectorsOn(s, null)).toEqual([]);
  });

  test('hiddenSites: one row per site, sorted by host, selectors kept in order; storeOfSites inverts it', () => {
    const s = store({ 'b.example': ['#x'], 'a.example': ['.a', '.b'] });
    const rows = hiddenSites(s);
    expect(rows).toEqual([
      { host: 'a.example', selectors: ['.a', '.b'] },
      { host: 'b.example', selectors: ['#x'] },
    ]);
    expect(storeOfSites(rows)).toEqual(s);
  });
});

describe('UserFilterHostsSchema (answers and backups, P2-22)', () => {
  const ok = (value: unknown): boolean => v.safeParse(UserFilterHostsSchema, value).success;

  test('accepts hosts with sanitised selectors', () => {
    expect(ok({ 'a.example': ['#ad', '.banner > div'] })).toBe(true);
    expect(ok({})).toBe(true);
  });

  test.each([
    ['an invalid host', { 'Bad Host': ['#a'] }],
    ['an unsafe selector', { 'a.example': ['a{}'] }],
    ['a selector with spaces around it', { 'a.example': [' #a'] }],
    ['an empty list', { 'a.example': [] }],
    ['a duplicate selector', { 'a.example': ['#a', '#a'] }],
    ['too many selectors', { 'a.example': Array.from({ length: MAX_SELECTORS_PER_HOST + 1 }, (_, i) => `.s${String(i)}`) }],
    ['too many hosts', Object.fromEntries(Array.from({ length: MAX_HOSTS + 1 }, (_, i) => [`h${String(i)}.example`, ['#a']]))],
    ['not a record', ['#a']],
  ])('refuses %s', (_name, value) => {
    expect(ok(value)).toBe(false);
  });
});
