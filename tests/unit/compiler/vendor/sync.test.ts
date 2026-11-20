import { describe, expect, test } from 'vitest';
import { checkVendored, serialiseVendorLock, sha256Bytes, VendorLockSchema, type VendorLock } from '../../../../compiler/vendor/lock.js';
import { pinVendor, syncVendor, type VendorPorts } from '../../../../compiler/vendor/sync.js';

const COMMIT = 'a'.repeat(40);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const lockOf = (files: Record<string, string>): VendorLock => ({ schema: 1, repo: 'gorhill/uBlock', commit: COMMIT,
  files: Object.fromEntries(Object.entries(files).map(([f, t]) => [f, sha256Bytes(bytes(t))])) });

function ports(source: Record<string, string>, local: Record<string, string> = {}) {
  const disk = new Map(Object.entries(local).map(([f, t]) => [f, bytes(t)]));
  const asked: string[] = [];
  const p: VendorPorts = {
    readLocal: (f) => Promise.resolve(disk.get(f) ?? null),
    writeLocal: (f, b) => { disk.set(f, b); return Promise.resolve(); },
    readSource: (commit, f) => { asked.push(`${commit}:${f}`); const t = source[f]; return t === undefined ? Promise.reject(new Error('404')) : Promise.resolve(bytes(t)); },
  };
  return { p, disk, asked };
}

describe('vendored uBO files (ADR-005)', () => {
  test('fetches missing or changed files at the locked commit and keeps matching ones', async () => {
    const lock = lockOf({ 'a.js': 'A', 'b.js': 'B' });
    const { p, disk, asked } = ports({ 'a.js': 'A', 'b.js': 'B' }, { 'a.js': 'A', 'b.js': 'tampered' });
    const r = await syncVendor(lock, p);
    expect(r).toEqual({ fetched: ['b.js'], present: ['a.js'] });
    expect(asked).toEqual([`${COMMIT}:b.js`]);
    expect(new TextDecoder().decode(disk.get('b.js'))).toBe('B');
  });

  test('refuses source bytes that differ from the lock and writes nothing', async () => {
    const { p, disk } = ports({ 'a.js': 'evil' });
    await expect(syncVendor(lockOf({ 'a.js': 'A' }), p)).rejects.toThrow(/SHA-256/);
    expect(disk.size).toBe(0);
  });

  test('checkVendored refuses an unlisted file', () => {
    expect(() => { checkVendored(lockOf({}), 'x.js', bytes('x')); }).toThrow(/not in vendor.lock.json/);
  });

  test('pin re-hashes the source; serialisation is sorted and round-trips through the schema', async () => {
    const { p } = ports({ 'b.js': 'B2', 'a.js': 'A' });
    const next = await pinVendor({ repo: 'gorhill/uBlock' }, COMMIT, ['b.js', 'a.js', 'a.js'], p);
    expect(Object.keys(next.files)).toEqual(['a.js', 'b.js']);
    const text = serialiseVendorLock(next);
    expect(VendorLockSchema.parse(JSON.parse(text))).toEqual(next);
  });

  test('the schema refuses paths that climb out and short hashes', () => {
    expect(VendorLockSchema.safeParse({ schema: 1, repo: 'a/b', commit: COMMIT, files: [{ path: '../x', sha256: 'f'.repeat(64) }] }).success).toBe(false);
    expect(VendorLockSchema.safeParse({ schema: 1, repo: 'a/b', commit: COMMIT, files: [{ path: 'x.js', sha256: 'abc' }] }).success).toBe(false);
  });

  test('the committed lock pins the S-03 commit', async () => {
    const { loadVendorLock } = await import('../../../../compiler/vendor/node-ports.js');
    const lock = await loadVendorLock();
    expect(lock.commit).toBe('2bc679d99afe5bddd8fe3ab60137966a12123f41');
    expect(Object.keys(lock.files)).toContain('platform/mv3/extension/js/scripting/css-procedural-api.js');
  });
});
