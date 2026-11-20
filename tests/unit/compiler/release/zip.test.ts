import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { readZip, writeZip, type ZipEntry } from '../../../../compiler/release/zip.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** A zip the way other tools write it: an extra field in the local header and a comment. */
function foreignZip(name: string, data: Buffer): Buffer {
  const body = deflateRawSync(data);
  const crc = crc32(data);
  const n = Buffer.from(name);
  const extra = Buffer.from([0x55, 0x54, 0x01, 0x00, 0x00]);
  const common = [u16(20), u16(0), u16(8), u16(0), u16(0x21), u32(crc), u32(body.length), u32(data.length), u16(n.length)];
  const local = Buffer.concat([u32(0x04034b50), ...common, u16(extra.length), n, extra, body]);
  const central = Buffer.concat([u32(0x02014b50), u16(20), ...common, u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), n]);
  const comment = Buffer.from('made elsewhere');
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(comment.length), comment]);
  return Buffer.concat([local, central, end]);
}

describe('deterministic zip (S-08, P2-01)', () => {
  test('round-trips entries, sorted by path, whatever the input order', () => {
    const zip = writeZip([{ path: 'b.json', data: text('{"b":1}') }, { path: 'a/x.js', data: text('x'.repeat(500)) }]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.path)).toEqual(['a/x.js', 'b.json']);
    expect(decode(entries[1]?.data ?? new Uint8Array())).toBe('{"b":1}');
    expect(entries[0]?.method).toBe(8);
  });

  test('the same entries give the same bytes', () => {
    const entries: ZipEntry[] = [{ path: 'm.json', data: text('{}') }, { path: 'r/a.json', data: text('[]') }];
    expect(Buffer.from(writeZip(entries)).equals(Buffer.from(writeZip([...entries].reverse())))).toBe(true);
  });

  test('an entry passed with its compressed bytes is copied unchanged', () => {
    const first = readZip(writeZip([{ path: 'big.js', data: text('abc'.repeat(1000)) }]));
    const original = first[0];
    if (original === undefined) throw new Error('no entry');
    const again = readZip(writeZip([{ ...original }]));
    expect(Buffer.from(again[0]?.raw ?? []).equals(Buffer.from(original.raw ?? []))).toBe(true);
    expect(decode(again[0]?.data ?? new Uint8Array())).toBe('abc'.repeat(1000));
  });

  test('reads a zip with extra fields and an archive comment', () => {
    const entries = readZip(foreignZip('manifest.json', Buffer.from('{"version":"1.0.1.1"}')));
    expect(entries.map((e) => [e.path, decode(e.data)])).toEqual([['manifest.json', '{"version":"1.0.1.1"}']]);
  });

  test('refuses a buffer that is not a zip, a duplicate path, and an unsafe path', () => {
    expect(() => readZip(text('not a zip at all, definitely not'))).toThrow(/central directory/);
    expect(() => writeZip([{ path: 'a', data: text('1') }, { path: 'a', data: text('2') }])).toThrow(/twice/);
    expect(() => writeZip([{ path: '../evil', data: text('1') }])).toThrow(/unsafe path/);
    expect(() => writeZip([{ path: '/abs', data: text('1') }])).toThrow(/unsafe path/);
  });

  test('refuses an entry whose bytes do not match its CRC', () => {
    const zip = Buffer.from(writeZip([{ path: 'a.txt', data: text('hello hello hello') }]));
    const dataStart = 30 + 'a.txt'.length;
    zip[dataStart] = (zip[dataStart] ?? 0) ^ 0xff;
    expect(() => readZip(zip)).toThrow();
  });
});

describe('the reader refuses ambiguous archives (security review)', () => {
  const two = (): Buffer => Buffer.from(writeZip([{ path: 'a.json', data: text('{"a":1}') }, { path: 'b.json', data: text('{"b":2}') }]));

  test('a duplicate path (also by case) is refused', () => {
    const z = two();
    // Rename b.json → A.json in both headers: same length, so offsets stay valid; CRCs still match the data.
    const at = (from: number) => z.indexOf('b.json', from);
    const first = at(0);
    z.write('A.json', first);
    z.write('A.json', at(first + 1));
    expect(() => readZip(z)).toThrow(/listed twice/);
  });

  test('an unsafe path written by another tool is refused', () => {
    const z = two();
    const first = z.indexOf('b.json');
    z.write('../b.j', first);
    z.write('../b.j', z.indexOf('b.json', first + 1));
    expect(() => readZip(z)).toThrow(/unsafe path/);
  });

  test('a local header that disagrees with the central directory is refused', () => {
    const z = two();
    z.write('c', z.indexOf('b.json'));
    expect(() => readZip(z)).toThrow(/disagrees/);
  });

  test('trailing bytes after the end record, or a truncated archive, are refused', () => {
    expect(() => readZip(Buffer.concat([two(), Buffer.from('junk')]))).toThrow();
    expect(() => readZip(two().subarray(10))).toThrow();
  });

  test('an entry that inflates beyond its declared size is refused', () => {
    const z = two();
    const central = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    z.writeUInt32LE(3, central + 24);
    expect(() => readZip(z)).toThrow(/size of a\.json/);
  });
});
