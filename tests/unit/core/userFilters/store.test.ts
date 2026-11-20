import { describe, expect, test } from 'vitest';
import type { Hostname } from '../../../../src/core/ids.js';
import { auditMirror, MIRROR_PREFIX, mirrorKey, mirrorOf, readMirrorEntry } from '../../../../src/core/userFilters/mirror.js';
import {
  addUserFilter, EMPTY_USER_FILTERS, filterHostKey, filterHosts, isUnreadableStore, MAX_HOSTS, MAX_SELECTORS_PER_HOST, readUserFilters, removeUserFilter, type UserFilters,
} from '../../../../src/core/userFilters/store.js';

const H = 'news.example.com' as Hostname;
const store = (hosts: Readonly<Record<string, readonly string[]>>): UserFilters => ({ v: 1, hosts: hosts });

describe('user filter store (vault, P2-20)', () => {
  test('add: sanitised, de-duplicated, sorted; a new object', () => {
    const a = addUserFilter(EMPTY_USER_FILTERS, H, ' #b ');
    if (!a.ok) throw new Error('refused');
    const b = addUserFilter(a.value, H, '.a');
    const c = b.ok ? addUserFilter(b.value, H, '#b') : b;
    expect(c).toEqual({ ok: true, value: store({ [H]: ['#b', '.a'] }) });
    expect(EMPTY_USER_FILTERS.hosts).toEqual({});
  });

  test.each([['a{}'], [''], ['x'.repeat(1_025)], ['url(x)']])('refuses unsafe selector %j', (sel) => {
    expect(addUserFilter(EMPTY_USER_FILTERS, H, sel).ok).toBe(false);
  });

  test('refuses past the per-host and host caps', () => {
    const full = store({ [H]: Array.from({ length: MAX_SELECTORS_PER_HOST }, (_, i) => `.s${String(i).padStart(3, '0')}`) });
    expect(addUserFilter(full, H, '.new').ok).toBe(false);
    const many = store(Object.fromEntries(Array.from({ length: MAX_HOSTS }, (_, i) => [`h${String(i)}.example`, ['.a']])));
    expect(addUserFilter(many, 'other.example' as Hostname, '.a').ok).toBe(false);
    expect(addUserFilter(many, 'h1.example' as Hostname, '.b').ok).toBe(true);
  });

  test('remove: drops the selector, and the host when it was the last; unknown is a no-op', () => {
    const s = store({ [H]: ['#b', '.a'], 'x.example': ['.z'] });
    expect(removeUserFilter(s, H, '#b')).toEqual(store({ [H]: ['.a'], 'x.example': ['.z'] }));
    expect(removeUserFilter(s, 'x.example' as Hostname, '.z')).toEqual(store({ [H]: ['#b', '.a'] }));
    expect(removeUserFilter(s, H, '.nope')).toBe(s);
  });

  test('readUserFilters: the vault value validated; anything off is dropped, never trusted', () => {
    expect(readUserFilters(undefined)).toEqual(EMPTY_USER_FILTERS);
    expect(readUserFilters({ v: 2, hosts: {} })).toEqual(EMPTY_USER_FILTERS);
    expect(readUserFilters({ v: 1, hosts: { [H]: ['.a', 'a{}', '.a'], 'Bad Host': ['.b'], 'y.example': 'x', 'z.example': [] } }))
      .toEqual(store({ [H]: ['.a'] }));
  });

  test('isUnreadableStore: absent is fine, anything else malformed is unreadable', () => {
    expect([undefined, { v: 1, hosts: {} }].map(isUnreadableStore)).toEqual([false, false]);
    expect([null, 'x', { v: 2, hosts: {} }, { v: 1 }, { v: 1, hosts: null }].map(isUnreadableStore)).toEqual([true, true, true, true, true]);
  });

  test('filterHostKey strips a leading www. only when a dotted host remains', () => {
    expect([filterHostKey('www.example.com' as Hostname), filterHostKey('www.localhost' as Hostname), filterHostKey('a.example.com' as Hostname)])
      .toEqual(['example.com', 'www.localhost', 'a.example.com']);
  });

  test('filterHosts are sorted', () => {
    expect(filterHosts(store({ 'b.example': ['.a'], 'a.example': ['.a'] }))).toEqual(['a.example', 'b.example']);
  });
});

describe('storage.local mirror (untrusted copy, P2-20)', () => {
  const s = store({ [H]: ['#b', '.a'] });
  test('one `uf:<host>` entry per host', () => {
    expect(mirrorOf(s)).toEqual({ [`uf:${H}`]: { v: 1, s: ['#b', '.a'] } });
    expect(mirrorKey(H)).toBe(`${MIRROR_PREFIX}${H}`);
  });

  test('readMirrorEntry: the content-script guard (display:none only, sanitised selectors)', () => {
    expect(readMirrorEntry({ v: 1, s: ['.a', 'b{}', 7, '#c'] })).toEqual(['#c', '.a']);
    expect(readMirrorEntry({ v: 2, s: ['.a'] })).toEqual([]);
    expect(readMirrorEntry(null)).toEqual([]);
    expect(readMirrorEntry({ v: 1, s: 'x' })).toEqual([]);
    expect(readMirrorEntry({ v: 1, s: Array.from({ length: 500 }, (_, i) => `.a${String(i)}`) })).toHaveLength(MAX_SELECTORS_PER_HOST);
  });

  test('audit: rewrites a tampered or missing entry, deletes one without a vault entry, ignores other keys', () => {
    const actual = { [`uf:${H}`]: { v: 1, s: ['body'] }, 'uf:evil.example': { v: 1, s: ['html'] }, other: 1 };
    expect(auditMirror(s, actual)).toEqual({ set: { [`uf:${H}`]: { v: 1, s: ['#b', '.a'] } }, remove: ['uf:evil.example'] });
    expect(auditMirror(s, { [`uf:${H}`]: { v: 1, s: ['#b', '.a'] } })).toEqual({ set: {}, remove: [] });
    expect(auditMirror(s, {})).toEqual({ set: mirrorOf(s), remove: [] });
  });
});
