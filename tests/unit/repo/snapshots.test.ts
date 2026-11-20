/**
 * D-123 / D-124 on the real tree: `lists/snapshots/` holds exactly the locked bytes of the unversioned,
 * cleared lists, each under its own hash, and nothing of an owner-pending list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadListsConfig, loadLock } from '../../../compiler/config/load.js';
import { sha256Hex } from '../../../compiler/fetch/fetch.js';
import { snapshotHashes } from '../../../compiler/fetch/snapshots.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DIR = path.join(ROOT, 'lists/snapshots');
const SNAPSHOT_FILE = /^[0-9a-f]{64}\.txt$/;
const names = readdirSync(DIR);
const hashes = names.filter((n) => SNAPSHOT_FILE.test(n)).map((n) => n.slice(0, 64)).sort();
const load = async () => ({ config: await loadListsConfig(path.join(ROOT, 'lists/lists.config.json')), lock: await loadLock(path.join(ROOT, 'lists/lists.lock.json')) });

describe('lists/snapshots (D-123, D-124)', () => {
  test('holds exactly the cleared snapshot entries of the lock, and nothing else but .gitattributes', async () => {
    const { config, lock } = await load();
    expect(hashes).toEqual(snapshotHashes(config, lock));
    expect(names.filter((n) => !SNAPSHOT_FILE.test(n))).toEqual(['.gitattributes']);
  });

  test.each(hashes)('%s.txt hashes to its name', (sha) => {
    expect(sha256Hex(readFileSync(path.join(DIR, `${sha}.txt`), 'utf8'))).toBe(sha);
  });

  test('stores no bytes of an owner-pending list', async () => {
    const { config, lock } = await load();
    const pending = config.lists.filter((l) => l.licenceState !== 'cleared').map((l) => lock.lists[l.id]?.sha256);
    expect(pending.filter((sha) => sha !== undefined && hashes.includes(sha))).toEqual([]);
  });

  test('CREDITS.md marks no list Cleared while the config has it owner-pending (D-138)', async () => {
    const { config } = await load();
    const credits = readFileSync(path.join(ROOT, 'CREDITS.md'), 'utf8');
    const pendingRows = credits.split('\n').filter((l) => l.trimEnd().endsWith('| Pending (owner to confirm) |'));
    const pendingLists = config.lists.filter((l) => l.licenceState === 'owner-pending');
    expect(credits).not.toContain('Cleared (owner to confirm)');
    // es and pt share one row.
    expect(pendingRows).toHaveLength(pendingLists.length === 0 ? 0 : 2);
  });

  test('git never converts their line ends', () => {
    expect(readFileSync(path.join(DIR, '.gitattributes'), 'utf8')).toBe('*.txt -text\n');
  });
});
