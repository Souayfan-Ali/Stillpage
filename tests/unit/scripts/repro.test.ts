import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { diffTrees, forbiddenMarkers, hashTree, treeDigest } from '../../../scripts/repro/compare.js';

const dirs: string[] = [];
async function tree(files: Record<string, string | Uint8Array>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'glassmere-repro-test-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('tree hashes (P2-48: text and binary files alike)', () => {
  test('every file by relative path, sorted, binary bytes included', async () => {
    const dir = await tree({ 'b.txt': 'b', 'a/x.gif': new Uint8Array([0x47, 0x49, 0x46, 0x00, 0xff]) });
    const hashes = await hashTree(dir);
    expect([...hashes.keys()]).toEqual(['a/x.gif', 'b.txt']);
    expect(hashes.get('b.txt')).toBe('3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d');
  });

  test('a one-byte change in a binary file is a difference; added and removed files are named', async () => {
    const a = await hashTree(await tree({ 's.gif': new Uint8Array([1, 2, 3]), 'same.js': 'x', 'gone.js': 'g' }));
    const b = await hashTree(await tree({ 's.gif': new Uint8Array([1, 2, 4]), 'same.js': 'x', 'new.js': 'n' }));
    expect(diffTrees(a, b)).toEqual({ differ: ['s.gif'], onlyA: ['gone.js'], onlyB: ['new.js'] });
    expect(diffTrees(a, a)).toEqual({ differ: [], onlyA: [], onlyB: [] });
  });

  test('the tree digest is the SHA-256 of "<hash>  <path>" lines, so it can be checked with sha256sum', async () => {
    const hashes = await hashTree(await tree({ 'b.txt': 'b', 'a.txt': 'a' }));
    const lines = [...hashes].map(([p, h]) => `${h}  ${p}\n`).join('');
    expect(treeDigest(hashes)).toEqual({ manifest: lines, sha256: (await import('node:crypto')).createHash('sha256').update(lines).digest('hex') });
  });
});

describe('release safety: the production build carries no log-only path (P2-61 contract)', () => {
  test('a clean tree passes; the define, the env name or the decision-log attribute fail with the file named', async () => {
    expect(await forbiddenMarkers(await tree({ 'background.js': 'console', 'p.html': '<html>' }))).toEqual([]);
    const dirty = await tree({ 'cs/popup-sentinel.js': 'document.documentElement.setAttribute("data-sp-log", x)', 'ok.js': 'fine', 'x.gif': new Uint8Array([0]) });
    expect(await forbiddenMarkers(dirty)).toEqual(['cs/popup-sentinel.js: data-sp-log']);
  });
});
