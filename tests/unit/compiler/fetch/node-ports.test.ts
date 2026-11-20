import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { sha256Hex } from '../../../../compiler/fetch/fetch.js';
import { nodePorts, presentSnapshots, syncSnapshots } from '../../../../compiler/fetch/node-ports.js';

const A = 'list a\n';
const B = 'list b\r\n';
const SHA_A = sha256Hex(A);
const SHA_B = sha256Hex(B);

let root = '';
const dir = (name: string): string => path.join(root, name);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'glassmere-ports-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('nodePorts stores', () => {
  test('reads the cache first, then each read-only dir in order; a file missing everywhere is null', async () => {
    await mkdir(dir('cache'));
    await mkdir(dir('ro1'));
    await mkdir(dir('ro2'));
    await writeFile(path.join(dir('ro1'), `${SHA_A}.txt`), 'from ro1');
    await writeFile(path.join(dir('ro2'), `${SHA_A}.txt`), 'from ro2');
    await writeFile(path.join(dir('ro2'), `${SHA_B}.txt`), B);
    const ports = nodePorts(dir('cache'), [dir('ro1'), dir('ro2')]);
    expect(await ports.readCache(SHA_A)).toBe('from ro1');
    expect(await ports.readCache(SHA_B)).toBe(B);
    await writeFile(path.join(dir('cache'), `${SHA_A}.txt`), A);
    expect(await ports.readCache(SHA_A)).toBe(A);
    expect(await ports.readCache('0'.repeat(64))).toBeNull();
  });

  test('moves on only when a file is missing: any other read error is thrown', async () => {
    await mkdir(path.join(dir('ro'), `${SHA_A}.txt`), { recursive: true });
    await expect(nodePorts(dir('cache'), [dir('ro')]).readCache(SHA_A)).rejects.toThrow(/EISDIR/);
  });

  test('writes only to the cache dir', async () => {
    await nodePorts(dir('cache'), [dir('ro')]).writeCache(SHA_A, A);
    expect(await readFile(path.join(dir('cache'), `${SHA_A}.txt`), 'utf8')).toBe(A);
    expect(await presentSnapshots(dir('ro'))).toEqual([]);
  });
});

describe('syncSnapshots', () => {
  test('writes wanted bytes, removes stale ones and leaves other names alone', async () => {
    const snap = dir('snap');
    await mkdir(snap);
    await writeFile(path.join(snap, '.gitattributes'), '*.txt -text\n');
    await writeFile(path.join(snap, 'notes.txt'), 'keep');
    await writeFile(path.join(snap, `${SHA_B}.txt`), B);
    const cache = nodePorts(dir('cache'));
    await cache.writeCache(SHA_A, A);
    await syncSnapshots(snap, { write: [SHA_A], remove: [SHA_B] }, cache.readCache);
    expect((await readdir(snap)).sort()).toEqual(['.gitattributes', `${SHA_A}.txt`, 'notes.txt']);
    expect(await readFile(path.join(snap, `${SHA_A}.txt`), 'utf8')).toBe(A);
    expect(await presentSnapshots(snap)).toEqual([SHA_A]);
  });

  test('refuses bytes that do not hash to their name, a hash missing from the cache, and a non-hash name', async () => {
    const cache = nodePorts(dir('cache'));
    await cache.writeCache(SHA_A, 'tampered');
    await expect(syncSnapshots(dir('snap'), { write: [SHA_A], remove: [] }, cache.readCache)).rejects.toThrow(/do not hash/);
    await expect(syncSnapshots(dir('snap'), { write: [SHA_B], remove: [] }, cache.readCache)).rejects.toThrow(/not in the cache/);
    await expect(syncSnapshots(dir('snap'), { write: [], remove: ['../evil'] }, cache.readCache)).rejects.toThrow(/not a sha256/);
    expect(await presentSnapshots(dir('snap'))).toEqual([]);
  });
});
