import { describe, expect, test } from 'vitest';
import { recordOf } from '../../../../compiler/release/record.js';
import { compareWithRecord, zipOfCrx } from '../../../../compiler/release/verify.js';
import { writeZip } from '../../../../compiler/release/zip.js';
import { BASE_FILES, extensionZip, manifestText, text } from './fixtures.js';

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
/** A CRX3 as the store serves it: magic, version 3, header length, a (fake) signed header, then the zip. */
const crx = (zip: Uint8Array, header = Buffer.from('signed-header-proto')): Uint8Array =>
  new Uint8Array(Buffer.concat([Buffer.from('Cr24'), u32(3), u32(header.length), header, Buffer.from(zip)]));

const RELEASE = extensionZip();
const RECORD = recordOf(RELEASE);
const compare = (pkg: Uint8Array) => compareWithRecord(RECORD, RELEASE, zipOfCrx(pkg));

/** The published package with the store's additions: `_metadata/` and an `update_url` in the manifest. */
function published(files: Readonly<Record<string, string>> = BASE_FILES, manifest = manifestText('1.0.317.600', ',"update_url":"https://clients2.google.com/service/update2/crx"')): Uint8Array {
  return crx(writeZip([{ path: 'manifest.json', data: text(manifest) }, { path: '_metadata/verified_contents.json', data: text('[]') },
    ...Object.entries(files).map(([path, data]) => ({ path, data: text(data) }))]));
}

describe('published package vs release record (tooling notes §8, P2-07)', () => {
  test('the zip inside a CRX3 is found; anything else is refused', () => {
    const zip = extensionZip();
    expect(Buffer.from(zipOfCrx(crx(zip))).equals(Buffer.from(zip))).toBe(true);
    expect(() => zipOfCrx(text('PK not a crx'))).toThrow(/CRX3/);
    expect(() => zipOfCrx(new Uint8Array(Buffer.concat([Buffer.from('Cr24'), u32(2), u32(0)])))).toThrow(/CRX3/);
    expect(() => zipOfCrx(new Uint8Array(Buffer.concat([Buffer.from('Cr24'), u32(3), u32(9999)])))).toThrow(/header/);
  });

  test('the store re-signs and adds _metadata/ and update_url: still a match', () => {
    expect(compare(published())).toEqual({ match: true, problems: [] });
  });

  test('a release zip that is not the recorded one is refused before comparing', () => {
    expect(compareWithRecord(RECORD, extensionZip({ version: '9.9.9.9' }), zipOfCrx(published()))).toEqual({ match: false, problems: ['the release zip is not the recorded one'] });
  });

  test('a changed, missing or extra file, or a changed manifest key, is a mismatch', () => {
    const changed = compare(published({ ...BASE_FILES, 'background.js': 'evil()' }));
    expect(changed).toEqual({ match: false, problems: ['changed: background.js'] });
    const rest = Object.fromEntries(Object.entries(BASE_FILES).filter(([p]) => p !== 'catalog.json'));
    expect(compare(published({ ...rest, 'new.js': 'x' })).problems).toEqual(['extra: new.js', 'missing: catalog.json']);
    const perm = manifestText('1.0.317.600', ',"update_url":"u","host_permissions":["<all_urls>"]');
    expect(compare(published(BASE_FILES, perm)).problems).toEqual(['changed: manifest.json (beyond the store\'s update_url / key)']);
    expect(compare(published(BASE_FILES, manifestText('1.0.318.600'))).problems).toEqual(['version: published 1.0.318.600, record 1.0.317.600']);
  });
});
