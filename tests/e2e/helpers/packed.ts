/**
 * TEST-ONLY. Never imported by `src/`, `compiler/` or `scripts/` (checked by `tests/unit/repo/release-safety.test.ts`);
 * every profile it touches must pass `assertThrowawayProfile` (a temp dir this test run created).
 *
 * A packed, persistent install in Playwright's Chromium (D-33 spike, P2-09), without
 * root, policy files or `--load-extension`:
 * - install: the extension's files go where Chromium keeps a store install (`<profile>/Default/Extensions/<id>/<version>_0`)
 *   and a `location: 1` (internal) entry goes into `Preferences`, with the tracked-preference MAC Chromium checks
 *   (HMAC-SHA256; unbranded Linux Chromium uses an empty seed and an empty device id, verified in the spike);
 * - update: the manifest's `update_url` points at a local server that answers `updates.xml` with a CRX3 of a higher
 *   version signed with the same throwaway key (`chromium --pack-extension`), so Chromium's own updater installs it.
 * Background networking must be on for the updater; the fixture server's host-resolver rules keep every
 * hostname on loopback, and the update server is an IP literal.
 */
import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type BrowserContext } from '@playwright/test';
import { assertThrowawayProfile } from './throwawayProfile.js';

const run = promisify(execFile);
const LOCATION_INTERNAL = 1;
const ID_CHARS = 32;
const HEX = 16;

export interface PackedKey {
  readonly pem: string;
  readonly publicKey: string;
  readonly id: string;
}

/** A throwaway RSA key and the extension id it gives (first 128 bits of SHA-256 of the public key, a–p). */
export async function packedKey(dir: string): Promise<PackedKey> {
  const pem = path.join(dir, 'throwaway-key.pem');
  await run('openssl', ['genrsa', '-out', pem, '2048']);
  const der = (await run('openssl', ['rsa', '-in', pem, '-pubout', '-outform', 'DER'], { encoding: 'buffer' })).stdout;
  const hex = createHash('sha256').update(der).digest('hex').slice(0, ID_CHARS);
  // Hex digits only (ASCII), so a plain character split is exact.
  const id = Array.from({ length: hex.length }, (_, i) => String.fromCharCode('a'.charCodeAt(0) + parseInt(hex.charAt(i), HEX))).join('');
  return { pem, publicKey: der.toString('base64'), id };
}

/** Every file under `dir`, relative path → bytes. */
export async function readTree(dir: string): Promise<ReadonlyMap<string, Uint8Array>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)));
  return new Map(await Promise.all(files.map(async (f) => [f.split(path.sep).join('/'), new Uint8Array(await readFile(path.join(dir, f)))] as const)));
}

export async function writeTree(dir: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  for (const [name, data] of files) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), data);
  }
}

/** Packs `dir` into `<dir>.crx` with Chromium itself. */
export async function packCrx(dir: string, key: PackedKey): Promise<string> {
  await run(chromium.executablePath(), [`--pack-extension=${dir}`, `--pack-extension-key=${key.pem}`, '--headless=new', '--no-sandbox']);
  return `${dir}.crx`;
}

/** Drops empty objects and sorts keys, as Chromium serialises a value for its preference MAC. */
const macForm = (v: unknown): unknown => (v !== null && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, macForm((v as Record<string, unknown>)[k])])
    .filter(([, x]) => !(x !== null && typeof x === 'object' && Object.keys(x).length === 0)))
  : v);
const prefMac = (name: string, value: unknown): string => createHmac('sha256', '').update(name + JSON.stringify(macForm(value))).digest('hex').toUpperCase();

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' ? v as Json : {});

/** Installs the unpacked `dir` (whose manifest carries `key`) into an existing profile as a packed extension. */
export async function installPacked(profile: string, dir: string, id: string): Promise<void> {
  await assertThrowawayProfile(profile);
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Json;
  const version = String(manifest['version']);
  await cp(dir, path.join(profile, 'Default', 'Extensions', id, `${version}_0`), { recursive: true });
  const file = path.join(profile, 'Default', 'Preferences');
  const prefs = JSON.parse(await readFile(file, 'utf8')) as Json;
  // What the user granted at install time; without it Chromium disables the extension (permissions increase).
  const granted = { api: manifest['permissions'] ?? [], explicit_host: manifest['host_permissions'] ?? [], manifest_permissions: [], scriptable_host: [] };
  const entry = { location: LOCATION_INTERNAL, path: `${id}/${version}_0`, state: 1, manifest, creation_flags: 1, from_webstore: false,
    install_time: '13370000000000000', granted_permissions: granted, active_permissions: granted };
  const extensions = obj(prefs['extensions']);
  const protection = obj(prefs['protection']);
  const macs = obj(protection['macs']);
  const extMacs = obj(macs['extensions']);
  const next = {
    ...prefs,
    extensions: { ...extensions, settings: { ...obj(extensions['settings']), [id]: entry } },
    protection: { ...protection, macs: { ...macs, extensions: { ...extMacs, settings: { ...obj(extMacs['settings']), [id]: prefMac(`extensions.settings.${id}`, entry) } } } },
  };
  await writeFile(file, JSON.stringify(next));
}

/** Launches on `profile` with installed extensions enabled and no `--load-extension`. */
export async function launchPacked(profile: string, args: readonly string[], updates = false): Promise<BrowserContext> {
  await assertThrowawayProfile(profile);
  return chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [...args],
    ignoreDefaultArgs: ['--disable-extensions', ...(updates ? ['--disable-background-networking'] : [])],
  });
}

export interface UpdateServer {
  readonly url: string;
  /** Serves `crx` as version `version` of `id` from now on. */
  readonly offer: (id: string, version: string, crx: string) => void;
  readonly hits: () => readonly string[];
  readonly close: () => Promise<void>;
}

/** A local update server (Omaha `gupdate` protocol 2.0, the subset Chromium's extension updater reads). */
export async function startUpdateServer(): Promise<UpdateServer> {
  let offered: { id: string; version: string; crx: string } | undefined;
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const address = server.address();
    const base = typeof address === 'object' && address !== null ? `http://127.0.0.1:${String(address.port)}` : '';
    if (req.url?.startsWith('/updates.xml') === true) {
      res.setHeader('content-type', 'application/xml');
      const app = offered === undefined ? '' : `<app appid="${offered.id}"><updatecheck codebase="${base}/update.crx" version="${offered.version}"/></app>`;
      res.end(`<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">${app}</gupdate>`);
    } else if (req.url === '/update.crx' && offered !== undefined) {
      res.setHeader('content-type', 'application/x-chrome-extension');
      void readFile(offered.crx).then((b) => res.end(b));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/updates.xml`,
    offer: (id, version, crx) => { offered = { id, version, crx }; },
    hits: () => [...hits],
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => { resolve(); }); }),
  };
}
