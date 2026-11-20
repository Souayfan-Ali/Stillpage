import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { replaceTree, writeTree } from '../../../../compiler/build/node-ports.js';

/** P2-48 (D-34): `public/` is replaced atomically — a failed write leaves the previous tree whole. */
const roots: string[] = [];
async function publicDir(files: Record<string, string>): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'glassmere-public-test-'));
  roots.push(parent);
  const root = path.join(parent, 'public');
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body);
  }
  return root;
}

const read = (root: string, rel: string): Promise<string> => readFile(path.join(root, rel), 'utf8');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('replaceTree', () => {
  test('writes text and binary files; generated directories are replaced, other files kept', async () => {
    const root = await publicDir({ 'cosmetic/old-shard.json': 'stale', 'cosmetic/keep.json': 'old', 'icon.png': 'icon', 'catalog.json': 'old' });
    const files = new Map<string, string | Uint8Array>([
      ['cosmetic/keep.json', 'new'],
      ['catalog.json', 'new catalog'],
      ['surrogates/1x1.gif', new Uint8Array([0x47, 0x49, 0x46])],
    ]);
    await replaceTree(root, files, ['cosmetic', 'scriptlets', 'surrogates']);
    expect(existsSync(path.join(root, 'cosmetic/old-shard.json'))).toBe(false);
    expect(await read(root, 'cosmetic/keep.json')).toBe('new');
    expect(await read(root, 'catalog.json')).toBe('new catalog');
    expect(await read(root, 'icon.png')).toBe('icon');
    expect([...(await readFile(path.join(root, 'surrogates/1x1.gif')))]).toEqual([0x47, 0x49, 0x46]);
  });

  test('a failure while staging leaves the previous tree untouched, and no staging dir behind', async () => {
    const root = await publicDir({ 'cosmetic/a.json': 'old a', 'catalog.json': 'old' });
    // `x` as a file and as a directory cannot both be staged: the write fails part-way.
    const files = new Map<string, string>([
      ['catalog.json', 'new'],
      ['cosmetic/a.json', 'new a'],
      ['x', 'file'],
      ['x/y.json', 'under a file'],
    ]);
    await expect(replaceTree(root, files, ['cosmetic'])).rejects.toThrow();
    expect(await read(root, 'catalog.json')).toBe('old');
    expect(await read(root, 'cosmetic/a.json')).toBe('old a');
    expect((await readdir(path.dirname(root))).sort()).toEqual(['public']);
  });

  test('nothing is left beside or inside the tree after a success (WXT packages all of public/)', async () => {
    const root = await publicDir({ 'cosmetic/a.json': 'a' });
    await replaceTree(root, new Map([['cosmetic/b.json', 'b']]), ['cosmetic']);
    expect((await readdir(path.dirname(root))).sort()).toEqual(['public']);
    expect((await readdir(root, { recursive: true })).sort()).toEqual(['cosmetic', 'cosmetic/b.json']);
  });
});

describe('writeTree', () => {
  test('writes each file through a temporary name and a rename (no partial file at the final path)', async () => {
    const root = await publicDir({});
    await writeTree(root, new Map([['a/b.json', '{}']]));
    expect(await read(root, 'a/b.json')).toBe('{}');
    expect(await readdir(path.join(root, 'a'))).toEqual(['b.json']);
  });
});
