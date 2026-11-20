/**
 * Deterministic ZIP writer and reader for release tooling (S-08, P2-01). Determinism: entries sorted by
 * path (bytewise), fixed DOS time 1980-01-01 00:00, fixed attributes, no extra fields, deflate level 9,
 * UTF-8 flag. An entry given with its compressed bytes (`raw`, `method`, `crc`) is copied unchanged, which
 * is what lets a repack keep every untouched file byte-identical to the published zip.
 * Not supported (refused): ZIP64, encryption, multi-disk archives. The extension zip is far below 4 GiB.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly path: string;
  /** Uncompressed bytes. */
  readonly data: Uint8Array;
  /** Compressed bytes as stored; when set, written unchanged together with `method` and `crc`. */
  readonly raw?: Uint8Array;
  readonly method?: number;
  readonly crc?: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const END_MIN = 22;
const CENTRAL_FIXED = 46;
const LOCAL_FIXED = 30;
const MAX_COMMENT = 0xffff;
const VERSION = 20;
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const STORED = 0;
const DEFLATED = 8;
const DEFLATE_LEVEL = 9;
const FIXED_DOS_TIME = 0;
/** 1980-01-01: year 0 since 1980 (bits 9–15), month 1 (bits 5–8), day 1. */
const FIXED_DOS_DATE = (1 << 5) | 1;
const ZIP64_MARK = 0xffffffff;

const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** A relative, normalised path inside the archive: no `..`, no leading `/`, no backslash, no empty part. */
const isSafeZipPath = (p: string): boolean =>
  p.length > 0 && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((part, i, all) => part !== '..' && part !== '.' && (part !== '' || i === all.length - 1));

interface Encoded { readonly body: Uint8Array; readonly method: number; readonly crc: number }

function encode(e: ZipEntry): Encoded {
  if (e.raw !== undefined && e.method !== undefined && e.crc !== undefined) return { body: e.raw, method: e.method, crc: e.crc };
  const deflated = deflateRawSync(e.data, { level: DEFLATE_LEVEL });
  const useDeflate = deflated.length < e.data.length;
  return { body: useDeflate ? deflated : e.data, method: useDeflate ? DEFLATED : STORED, crc: crc32(e.data) };
}

function sortedChecked(entries: readonly ZipEntry[]): readonly ZipEntry[] {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  sorted.forEach((e, i) => {
    if (!isSafeZipPath(e.path)) throw new Error(`unsafe path in zip: ${e.path}`);
    if (i > 0 && sorted[i - 1]?.path === e.path) throw new Error(`path listed twice: ${e.path}`);
  });
  return sorted;
}

/** Writes `entries` as a deterministic zip. */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const sorted = sortedChecked(entries);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of sorted) {
    const name = Buffer.from(e.path, 'utf8');
    const { body, method, crc } = encode(e);
    const common = [u16(VERSION), u16(FLAG_UTF8), u16(method), u16(FIXED_DOS_TIME), u16(FIXED_DOS_DATE), u32(crc), u32(body.length), u32(e.data.length), u16(name.length), u16(0)];
    const local = Buffer.concat([u32(SIG_LOCAL), ...common, name, body]);
    centrals.push(Buffer.concat([u32(SIG_CENTRAL), u16(VERSION), ...common, u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.concat([u32(SIG_END), u16(0), u16(0), u16(sorted.length), u16(sorted.length), u32(cd.length), u32(offset), u16(0)]);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/** Caps against zip bombs: the extension zip is ≈ 3 MiB with ≈ 420 entries (P1-48). */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`corrupt zip: ${message}`);
}

/** The end record: it must end the buffer exactly (a fake record planted in a comment does not). */
function endRecord(buf: Buffer): number {
  const stop = Math.max(0, buf.length - END_MIN - MAX_COMMENT);
  for (let e = buf.length - END_MIN; e >= stop; e--) {
    if (buf.readUInt32LE(e) === SIG_END && e + END_MIN + buf.readUInt16LE(e + 20) === buf.length) return e;
  }
  throw new Error('not a zip: no end of central directory');
}

function inflate(raw: Buffer, method: number, size: number, path: string): Uint8Array {
  check(size <= MAX_ENTRY_BYTES, `${path} is larger than ${String(MAX_ENTRY_BYTES)} bytes`);
  if (method === STORED) return new Uint8Array(raw);
  if (method !== DEFLATED) throw new Error(`unsupported compression method ${String(method)} for ${path}`);
  return new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }));
}

interface Located { readonly entry: ZipEntry; readonly next: number; readonly start: number; readonly end: number }

function readEntry(buf: Buffer, p: number, cdEnd: number): Located {
  check(p + CENTRAL_FIXED <= cdEnd && buf.readUInt32LE(p) === SIG_CENTRAL, 'central directory');
  const flags = buf.readUInt16LE(p + 8);
  const method = buf.readUInt16LE(p + 10);
  const crc = buf.readUInt32LE(p + 16);
  const csize = buf.readUInt32LE(p + 20);
  const size = buf.readUInt32LE(p + 24);
  const nlen = buf.readUInt16LE(p + 28);
  const next = p + CENTRAL_FIXED + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  const lo = buf.readUInt32LE(p + 42);
  check(next <= cdEnd && buf.readUInt16LE(p + 34) === 0, 'central entry bounds');
  const nameBytes = buf.subarray(p + CENTRAL_FIXED, p + CENTRAL_FIXED + nlen);
  const path = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
  if ((flags & FLAG_ENCRYPTED) !== 0) throw new Error(`encrypted entry: ${path}`);
  if (csize === ZIP64_MARK || lo === ZIP64_MARK || size === ZIP64_MARK) throw new Error(`ZIP64 entry not supported: ${path}`);
  check(isSafeZipPath(path), `unsafe path ${path}`);
  check(lo + LOCAL_FIXED <= buf.length && buf.readUInt32LE(lo) === SIG_LOCAL, `local header of ${path}`);
  const lnlen = buf.readUInt16LE(lo + 26);
  check(buf.readUInt16LE(lo + 8) === method && nameBytes.equals(buf.subarray(lo + LOCAL_FIXED, lo + LOCAL_FIXED + lnlen)), `local header of ${path} disagrees with the central directory`);
  const start = lo + LOCAL_FIXED + lnlen + buf.readUInt16LE(lo + 28);
  check(start + csize <= buf.length, `data of ${path} runs past the end`);
  const raw = buf.subarray(start, start + csize);
  const data = inflate(raw, method, size, path);
  check(data.length === size, `size of ${path}`);
  if (crc32(data) !== crc) throw new Error(`CRC mismatch: ${path}`);
  return { entry: { path, data, raw: new Uint8Array(raw), method, crc }, next, start: lo, end: start + csize };
}

/** No two entries may share bytes, and no two names may collide (case-insensitively, as on some file systems). */
function checkDistinct(located: readonly Located[]): void {
  const names = new Set<string>();
  for (const l of located) {
    const key = l.entry.path.toLowerCase();
    if (names.has(key)) throw new Error(`path listed twice: ${l.entry.path}`);
    names.add(key);
  }
  const ranges = [...located].sort((a, b) => a.start - b.start);
  ranges.forEach((r, i) => { if (i > 0) check((ranges[i - 1]?.end ?? 0) <= r.start, `entries overlap at ${r.entry.path}`); });
}

/**
 * Reads every entry through the central directory and checks the archive is unambiguous: one end record at
 * the end, single disk, bounds, local headers that agree, safe and distinct paths, no overlap, CRCs, size caps.
 */
export function readZip(bytes: Uint8Array): readonly ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < END_MIN) throw new Error('not a zip: no end of central directory');
  const e = endRecord(buf);
  const count = buf.readUInt16LE(e + 10);
  const cdSize = buf.readUInt32LE(e + 12);
  const cdStart = buf.readUInt32LE(e + 16);
  check(buf.readUInt16LE(e + 4) === 0 && buf.readUInt16LE(e + 6) === 0 && buf.readUInt16LE(e + 8) === count, 'multi-disk archive');
  check(count <= MAX_ENTRIES && cdStart + cdSize === e, 'central directory bounds');
  const located: Located[] = [];
  let p = cdStart;
  let total = 0;
  for (let i = 0; i < count; i++) {
    const r = readEntry(buf, p, e);
    total += r.entry.data.length;
    check(total <= MAX_TOTAL_BYTES, 'archive larger than the total cap');
    located.push(r);
    p = r.next;
  }
  check(p === e, 'central directory size');
  checkDistinct(located);
  return located.map((l) => l.entry);
}
