/**
 * D-71: the store-key job runs no npm code. The ruleset publish path (uploader entry, store client, contract,
 * auth, fake, release flow) is dependency-free, runs with plain `node`, and its answer guards accept and refuse
 * what the zod schemas they replace did.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { sha256Hex } from '../../../../compiler/release/record.js';
import { zipManifestVersion } from '../../../../compiler/release/zipVersion.js';
import { ServiceAccountKeySchema } from '../../../../compiler/store/auth.js';
import { PublishResponseSchema, StatusResponseSchema, TokenResponseSchema, UploadResponseSchema } from '../../../../compiler/store/contract.js';
import { extensionZip, text } from '../release/fixtures.js';
import { writeZip } from '../../../../compiler/release/zip.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown): boolean => s.safeParse(v).success;

describe('store answer guards (D-71: hand-written, as the zod schemas were)', () => {
  test('token: access_token non-empty, expires_in a positive integer, token_type a string; extra keys kept', () => {
    expect(TokenResponseSchema.safeParse({ access_token: 't', expires_in: 3600, token_type: 'Bearer', x: 1 })).toEqual({ success: true, data: { access_token: 't', expires_in: 3600, token_type: 'Bearer', x: 1 } });
    for (const bad of [undefined, null, [], {}, { access_token: '', expires_in: 1, token_type: 'B' }, { access_token: 't', expires_in: 1.5, token_type: 'B' },
      { access_token: 't', expires_in: 0, token_type: 'B' }, { access_token: 't', expires_in: 1 }]) expect(ok(TokenResponseSchema, bad)).toBe(false);
  });

  test('upload: uploadState one of the known states; ids and version optional strings', () => {
    expect(ok(UploadResponseSchema, { uploadState: 'SUCCEEDED', crxVersion: '1.0.0.1', itemId: 'x' })).toBe(true);
    expect(ok(UploadResponseSchema, { uploadState: 'UPLOAD_STATE_UNSPECIFIED' })).toBe(true);
    for (const bad of [{}, { uploadState: 'DONE' }, { uploadState: 'SUCCEEDED', crxVersion: 1 }, { uploadState: 'SUCCEEDED', itemId: null }]) expect(ok(UploadResponseSchema, bad)).toBe(false);
  });

  test('status: optional revisions with known states and channel lists; booleans; upload state', () => {
    expect(ok(StatusResponseSchema, {})).toBe(true);
    expect(ok(StatusResponseSchema, { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1', deployPercentage: 100 }] },
      submittedItemRevisionStatus: { state: 'PENDING_REVIEW' }, lastAsyncUploadState: 'IN_PROGRESS', takenDown: false, warned: true })).toBe(true);
    for (const bad of [[], { warned: 'yes' }, { takenDown: 1 }, { lastAsyncUploadState: 'X' }, { publishedItemRevisionStatus: {} },
      { publishedItemRevisionStatus: { state: 'LIVE' } }, { submittedItemRevisionStatus: { state: 'STAGED', distributionChannels: {} } },
      { submittedItemRevisionStatus: { state: 'STAGED', distributionChannels: [{ crxVersion: 1 }] } },
      { submittedItemRevisionStatus: { state: 'STAGED', distributionChannels: [{ deployPercentage: '100' }] } }, { itemId: 3 }]) {
      expect(ok(StatusResponseSchema, bad)).toBe(false);
    }
  });

  test('publish: optional known state', () => {
    expect(ok(PublishResponseSchema, {})).toBe(true);
    expect(ok(PublishResponseSchema, { state: 'PUBLISHED', itemId: 'x' })).toBe(true);
    for (const bad of [null, { state: 'DONE' }, { itemId: 1 }]) expect(ok(PublishResponseSchema, bad)).toBe(false);
  });

  test('service-account key: type, an e-mail and a PEM private key', () => {
    const key = { type: 'service_account', client_email: 'a@b.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\n…', extra: 1 };
    expect(ServiceAccountKeySchema.parse(key)).toEqual(key);
    for (const bad of [{ ...key, type: 'user' }, { ...key, client_email: 'not-an-email' }, { ...key, private_key: 'x' }, null]) {
      expect(() => ServiceAccountKeySchema.parse(bad)).toThrow();
    }
  });
});

describe('zipManifestVersion (D-71)', () => {
  test('reads the version; throws without a manifest or a version string', () => {
    expect(zipManifestVersion(extensionZip({ version: '1.0.318.600' }))).toBe('1.0.318.600');
    expect(() => zipManifestVersion(writeZip([{ path: 'a.txt', data: text('x') }]))).toThrow(/no manifest\.json/);
    expect(() => zipManifestVersion(writeZip([{ path: 'manifest.json', data: text('{"version":""}') }]))).toThrow(/version/);
    expect(() => zipManifestVersion(writeZip([{ path: 'manifest.json', data: text('{') }]))).toThrow();
  });
});

/** Static imports of a source file, `import type` excluded (erased by type stripping). */
const importsOf = (file: string): readonly string[] =>
  [...readFileSync(file, 'utf8').matchAll(/^\s*import\s+(?!type\s)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');

describe('the uploader is dependency-free (D-71)', () => {
  const ENTRY = path.join(ROOT, 'compiler/store/uploader/main.ts');

  test('its transitive imports are node: built-ins and relative .ts files only', () => {
    const seen = new Set<string>();
    const external = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith('.')) {
          expect(spec, `${path.relative(ROOT, file)} imports ${spec}`).toMatch(/\.ts$/);
          walk(path.resolve(path.dirname(file), spec));
        } else external.add(spec);
      }
    };
    walk(ENTRY);
    expect([...external].filter((s) => !s.startsWith('node:'))).toEqual([]);
    expect([...seen].map((f) => path.relative(ROOT, f)).sort()).toEqual([
      'compiler/release/zip.ts', 'compiler/release/zipVersion.ts', 'compiler/store/auth.ts', 'compiler/store/client.ts', 'compiler/store/contract.ts',
      'compiler/store/fake.ts', 'compiler/store/release.ts', 'compiler/store/ruleset-cli.ts', 'compiler/store/uploader/main.ts', 'src/core/version.ts',
    ]);
  });

  test('plain node publishes a checked zip in dry run, and refuses a verdict for other bytes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'uploader-'));
    const zip = extensionZip({ version: '1.0.318.600' });
    const zipFile = path.join(dir, 'c.zip');
    writeFileSync(zipFile, zip);
    const verdict = (sha: string): string => { const f = path.join(dir, `v-${sha.slice(0, 4)}.json`); writeFileSync(f, JSON.stringify({ outcome: 'publish', candidateSha256: sha })); return f; };
    const run = (v: string) => spawnSync(process.execPath, [ENTRY, '--zip', zipFile, '--verdict', v, '--fake-published', '1.0.317.600'],
      { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    const good = run(verdict(sha256Hex(zip)));
    expect(good.stderr).toBe('');
    expect(good.status).toBe(0);
    expect(good.stdout).toMatch(/dry run: recorded-contract fake/);
    expect(good.stdout).toMatch(/"kind":"live","version":"1\.0\.318\.600"/);
    const other = run(verdict('0'.repeat(64)));
    expect(other.status).toBe(1);
    expect(other.stderr).toMatch(/the gate verdict is for another zip/);
  });
});
