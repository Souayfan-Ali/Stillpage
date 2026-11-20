import { describe, expect, test } from 'vitest';
import type { ListsConfig } from '../../../../compiler/config/schema.js';
import { fetchLists, loadLockedLists, sha256Hex, type FetchPorts } from '../../../../compiler/fetch/fetch.js';
import { EMPTY_LOCK, LockFileSchema, serialiseLock, withCarriedEntries, type LockFile } from '../../../../compiler/fetch/lock.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

const CONFIG: ListsConfig = {
  schema: 1,
  sources: { uassets: { kind: 'git', repo: 'uBlockOrigin/uAssets', branch: 'gh-pages' } },
  lists: [
    { id: 'ubo-filters', title: 'uBO', source: 'uassets', path: 'filters/filters.min.txt', licence: 'GPL-3.0-only',
      licenceState: 'cleared', trusted: true, format: 'adblock', homepage: 'https://github.com/uBlockOrigin/uAssets' },
    { id: 'urlhaus', title: 'URLhaus', url: 'https://malware.example/hosts.txt', licence: 'CC0-1.0',
      licenceState: 'cleared', trusted: false, format: 'hosts', homepage: 'https://malware.example/' },
  ],
  packs: { ads: { title: 'Ads', default: true }, malware: { title: 'Malware', default: true } },
  rulesets: [
    { id: 'ubo', pack: 'ads', category: 'ads', lists: ['ubo-filters'], slots: { safe: { rules: 10, regex: 0 } } },
    { id: 'urlhaus', pack: 'malware', category: 'malware', lists: ['urlhaus'], slots: { safe: { rules: 10, regex: 0 } } },
  ],
  popups: { id: 'popups', pack: 'ads', from: ['ubo'], budget: { rules: 10, regex: 0 } },
  content: { catalogRegistrations: false, maxLostEntities: 0 },
  oracle: { file: 'lists/oracle/ubol.json', rulesMin: -0.15, rulesMax: 0.4, regexMax: 0.2, failFactor: 2 },
};

/** In-memory ports: `remote` maps URL → body; records every download. */
function fakePorts(remote: Record<string, string>, head = COMMIT_A, day = '2026-11-14') {
  const cache = new Map<string, string>();
  const downloads: string[] = [];
  const ports: FetchPorts = {
    getText: (url) => {
      downloads.push(url);
      const body = remote[url];
      return body === undefined ? Promise.reject(new Error(`404 ${url}`)) : Promise.resolve(body);
    },
    latestCommit: () => Promise.resolve(head),
    readCache: (sha) => Promise.resolve(cache.get(sha) ?? null),
    writeCache: (sha, text) => { cache.set(sha, text); return Promise.resolve(); },
    today: () => day,
  };
  return { ports, cache, downloads };
}

const uboUrl = (commit: string) => `https://raw.githubusercontent.com/uBlockOrigin/uAssets/${commit}/filters/filters.min.txt`;
const remoteAt = (commit: string, ubo = '||ads.example^\n', hosts = 'bad.example\n') => ({
  [uboUrl(commit)]: ubo, 'https://malware.example/hosts.txt': hosts,
});

describe('fetchLists', () => {
  test('pins git lists to the branch head on a first fetch and records url, sha256 and ref', async () => {
    const { ports } = fakePorts(remoteAt(COMMIT_A));
    const { lock, changed } = await fetchLists(CONFIG, EMPTY_LOCK, ports, { refresh: false, refs: {} });
    expect(lock.lists['ubo-filters']).toEqual({ url: uboUrl(COMMIT_A), sha256: sha256Hex('||ads.example^\n'), bytes: 15,
      ref: { kind: 'git', repo: 'uBlockOrigin/uAssets', commit: COMMIT_A }, fetchedOn: '2026-11-14' });
    expect(lock.lists['urlhaus']?.ref).toEqual({ kind: 'snapshot' });
    expect(changed).toEqual(['ubo-filters', 'urlhaus']);
    expect(LockFileSchema.safeParse(lock).success).toBe(true);
  });

  test('rebuilds offline from the cache: a second run with the same lock downloads nothing', async () => {
    const { ports, downloads } = fakePorts(remoteAt(COMMIT_A));
    const first = await fetchLists(CONFIG, EMPTY_LOCK, ports, { refresh: false, refs: {} });
    downloads.length = 0;
    const second = await fetchLists(CONFIG, first.lock, { ...ports, latestCommit: () => Promise.reject(new Error('no network')) },
      { refresh: false, refs: {} });
    expect(downloads).toEqual([]);
    expect(second.changed).toEqual([]);
    expect(serialiseLock(second.lock)).toBe(serialiseLock(first.lock));
  });

  test('keeps the locked commit until refresh, then moves to the head and keeps fetchedOn for unchanged bytes', async () => {
    const remote = { ...remoteAt(COMMIT_A), ...remoteAt(COMMIT_B, '||ads2.example^\n') };
    const { ports } = fakePorts(remote, COMMIT_B);
    const lockA = (await fetchLists(CONFIG, EMPTY_LOCK, ports, { refresh: false, refs: { uassets: COMMIT_A } })).lock;
    const stay = await fetchLists(CONFIG, lockA, { ...ports, today: () => '2026-11-15' }, { refresh: false, refs: {} });
    expect(stay.lock.lists['ubo-filters']?.url).toBe(uboUrl(COMMIT_A));
    const moved = await fetchLists(CONFIG, lockA, { ...ports, today: () => '2026-11-15' }, { refresh: true, refs: {} });
    expect(moved.lock.lists['ubo-filters']).toMatchObject({ url: uboUrl(COMMIT_B), fetchedOn: '2026-11-15' });
    expect(moved.lock.lists['urlhaus']?.fetchedOn).toBe('2026-11-14');
    expect(moved.changed).toEqual(['ubo-filters']);
  });

  test('re-downloads a locked list whose bytes are missing from the cache', async () => {
    const a = fakePorts(remoteAt(COMMIT_A));
    const { lock } = await fetchLists(CONFIG, EMPTY_LOCK, a.ports, { refresh: false, refs: {} });
    const b = fakePorts(remoteAt(COMMIT_A));
    const again = await fetchLists(CONFIG, lock, b.ports, { refresh: false, refs: {} });
    expect(b.downloads).toHaveLength(2);
    expect(again.changed).toEqual([]);
  });

  test('fails when the same pinned URL now serves different bytes, or a snapshot moved without --refresh', async () => {
    const a = fakePorts(remoteAt(COMMIT_A));
    const { lock } = await fetchLists(CONFIG, EMPTY_LOCK, a.ports, { refresh: false, refs: {} });
    const b = fakePorts(remoteAt(COMMIT_A, '||tampered.example^\n'));
    await expect(fetchLists(CONFIG, lock, b.ports, { refresh: false, refs: {} })).rejects.toThrow(/now has sha256/);
    const c = fakePorts(remoteAt(COMMIT_A, undefined, 'moved.example\n'));
    await expect(fetchLists(CONFIG, lock, c.ports, { refresh: false, refs: {} })).rejects.toThrow(/use --refresh/);
    const moved = await fetchLists(CONFIG, lock, c.ports, { refresh: true, refs: {} });
    expect(moved.changed).toEqual(['urlhaus']);
  });

  test('rejects an empty download and propagates HTTP failures', async () => {
    const empty = fakePorts({ ...remoteAt(COMMIT_A), 'https://malware.example/hosts.txt': '  \n' });
    await expect(fetchLists(CONFIG, EMPTY_LOCK, empty.ports, { refresh: false, refs: {} })).rejects.toThrow(/empty download/);
    const missing = fakePorts({});
    await expect(fetchLists(CONFIG, EMPTY_LOCK, missing.ports, { refresh: false, refs: {} })).rejects.toThrow(/404/);
  });
});

describe('loadLockedLists', () => {
  async function lockedCache(): Promise<{ lock: LockFile; cache: Map<string, string>; ports: FetchPorts }> {
    const f = fakePorts(remoteAt(COMMIT_A));
    const { lock } = await fetchLists(CONFIG, EMPTY_LOCK, f.ports, { refresh: false, refs: {} });
    return { lock, cache: f.cache, ports: f.ports };
  }

  test('returns the text of every list when cache and lock agree', async () => {
    const { lock, ports } = await lockedCache();
    const texts = await loadLockedLists(CONFIG, lock, ports.readCache);
    expect(texts.get('urlhaus')).toBe('bad.example\n');
  });

  test('fails when a list is missing from the lock or the cache, or its bytes changed', async () => {
    const { lock, cache, ports } = await lockedCache();
    const rest = Object.fromEntries(Object.entries(lock.lists).filter(([id]) => id !== 'urlhaus'));
    await expect(loadLockedLists(CONFIG, { ...lock, lists: rest }, ports.readCache)).rejects.toThrow(/not in the lock/);
    const sha = lock.lists['urlhaus']?.sha256 ?? '';
    cache.set(sha, 'tampered\n');
    await expect(loadLockedLists(CONFIG, lock, ports.readCache)).rejects.toThrow(/do not match/);
    cache.delete(sha);
    await expect(loadLockedLists(CONFIG, lock, ports.readCache)).rejects.toThrow(/not in the cache/);
  });
});

describe('serialiseLock', () => {
  test('is independent of key order', async () => {
    const { ports } = fakePorts(remoteAt(COMMIT_A));
    const { lock } = await fetchLists(CONFIG, EMPTY_LOCK, ports, { refresh: false, refs: {} });
    const reversed: LockFile = { schema: 1, lists: Object.fromEntries(Object.entries(lock.lists).reverse()) };
    expect(serialiseLock(reversed)).toBe(serialiseLock(lock));
    expect(serialiseLock(lock).endsWith('\n')).toBe(true);
  });
});

describe('withCarriedEntries (D-124)', () => {
  const onlyUbo: ListsConfig = { ...CONFIG, lists: CONFIG.lists.filter((l) => l.id === 'ubo-filters') };

  test('a subset fetch keeps the dropped lists\' entries byte for byte', async () => {
    const { ports } = fakePorts(remoteAt(COMMIT_A));
    const { lock } = await fetchLists(CONFIG, EMPTY_LOCK, ports, { refresh: false, refs: {} });
    const subset = await fetchLists(onlyUbo, lock, ports, { refresh: false, refs: {} });
    expect(Object.keys(subset.lock.lists)).toEqual(['ubo-filters']);
    const merged = withCarriedEntries(subset.lock, lock, ['urlhaus']);
    expect(serialiseLock(merged)).toBe(serialiseLock(lock));
  });

  test('without carried ids a list removed from the config leaves the lock; an unknown carried id adds nothing', async () => {
    const { ports } = fakePorts(remoteAt(COMMIT_A));
    const { lock } = await fetchLists(CONFIG, EMPTY_LOCK, ports, { refresh: false, refs: {} });
    const subset = await fetchLists(onlyUbo, lock, ports, { refresh: false, refs: {} });
    expect(withCarriedEntries(subset.lock, lock, [])).toEqual(subset.lock);
    expect(withCarriedEntries(subset.lock, lock, ['gone'])).toEqual(subset.lock);
  });

  test('never replaces an entry the new lock has', async () => {
    const { ports } = fakePorts(remoteAt(COMMIT_A));
    const { lock } = await fetchLists(CONFIG, EMPTY_LOCK, ports, { refresh: false, refs: {} });
    const stale: LockFile = { schema: 1, lists: { 'ubo-filters': { ...lock.lists['ubo-filters'], sha256: '0'.repeat(64) } as LockFile['lists'][string] } };
    expect(withCarriedEntries(lock, stale, ['ubo-filters']).lists['ubo-filters']).toEqual(lock.lists['ubo-filters']);
  });
});
