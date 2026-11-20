import { describe, expect, test } from 'vitest';
import type { ListConfig, ListsConfig } from '../../../../compiler/config/schema.js';
import type { LockEntry, LockFile } from '../../../../compiler/fetch/lock.js';
import { snapshotHashes, snapshotPlan } from '../../../../compiler/fetch/snapshots.js';

const hex = (c: string): string => c.repeat(64);

const list = (id: string, licenceState: ListConfig['licenceState']): ListConfig => ({
  id, title: id, url: `https://lists.example/${id}.txt`, licence: 'GPL-3.0-only', licenceState, trusted: false,
  format: 'adblock', homepage: 'https://lists.example/',
});

const CONFIG = {
  lists: [list('git-list', 'cleared'), list('snap-b', 'cleared'), list('snap-a', 'cleared'), list('pending', 'owner-pending'), list('twin', 'cleared')],
} as unknown as ListsConfig;

const entry = (sha256: string, ref: LockEntry['ref']): LockEntry => ({ url: 'https://lists.example/x.txt', sha256, bytes: 1, ref, fetchedOn: '2026-11-15' });

const GIT_ENTRY = entry(hex('1'), { kind: 'git', repo: 'o/r', commit: 'c'.repeat(40) });
const PENDING_ENTRY = entry(hex('9'), { kind: 'snapshot' });
const LOCK: LockFile = {
  schema: 1,
  lists: {
    'git-list': GIT_ENTRY,
    'snap-b': entry(hex('b'), { kind: 'snapshot' }),
    'snap-a': entry(hex('a'), { kind: 'snapshot' }),
    pending: PENDING_ENTRY,
    twin: entry(hex('a'), { kind: 'snapshot' }),
  },
};

describe('snapshotHashes', () => {
  test('keeps cleared snapshot lists only, sorted and unique', () => {
    expect(snapshotHashes(CONFIG, LOCK)).toEqual([hex('a'), hex('b')]);
  });

  test('excludes git-pinned and owner-pending lists, and lists missing from the lock', () => {
    const hashes = snapshotHashes(CONFIG, { schema: 1, lists: { 'git-list': GIT_ENTRY, pending: PENDING_ENTRY } });
    expect(hashes).toEqual([]);
  });
});

describe('snapshotPlan', () => {
  test('writes what is wanted and missing, removes what is present and unwanted', () => {
    expect(snapshotPlan([hex('a'), hex('b')], [hex('b'), hex('c')])).toEqual({ write: [hex('a')], remove: [hex('c')] });
  });

  test('is a no-op when the directory already holds exactly the wanted hashes', () => {
    expect(snapshotPlan([hex('a'), hex('b')], [hex('b'), hex('a')])).toEqual({ write: [], remove: [] });
  });
});
