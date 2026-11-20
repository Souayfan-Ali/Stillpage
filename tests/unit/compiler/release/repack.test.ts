import { describe, expect, test } from 'vitest';
import { recordOf, ReleaseRecordSchema, sha256Hex } from '../../../../compiler/release/record.js';
import { repack, safeRulesetPaths } from '../../../../compiler/release/repack.js';
import { readZip } from '../../../../compiler/release/zip.js';
import { block, CATALOG, decode, extensionZip, manifestText, rulesText, text, UBO_RULES } from './fixtures.js';

const NEW_UBO = rulesText([...UBO_RULES, block(21, 'new.example')]);
const rulesets = (entries: Readonly<Record<string, string>>): ReadonlyMap<string, Uint8Array> =>
  new Map(Object.entries(entries).map(([p, s]) => [p, text(s)]));

describe('repack, do not rebuild (update-strategy notes §3.2, P2-01)', () => {
  test('only the given safe rulesets and the manifest version differ', () => {
    const base = extensionZip();
    const candidate = repack({ base, rulesets: rulesets({ 'rulesets/ubo.json': NEW_UBO }), version: '1.0.318.600' });
    const before = new Map(readZip(base).map((e) => [e.path, e]));
    const after = readZip(candidate);
    expect(after.map((e) => e.path)).toEqual([...before.keys()]);
    const changed = after.filter((e) => !Buffer.from(e.raw ?? []).equals(Buffer.from(before.get(e.path)?.raw ?? []))).map((e) => e.path);
    expect(changed).toEqual(['manifest.json', 'rulesets/ubo.json']);
    const manifest = decode(after.find((e) => e.path === 'manifest.json')?.data ?? new Uint8Array());
    expect(manifest).toBe(manifestText('1.0.318.600'));
    expect(decode(after.find((e) => e.path === 'rulesets/ubo.json')?.data ?? new Uint8Array())).toBe(NEW_UBO);
  });

  test('a version-only repack changes only the manifest', () => {
    const base = extensionZip();
    const same = rulesets({ 'rulesets/easylist.json': rulesText([block(1, 'banner.example')]) });
    const after = readZip(repack({ base, rulesets: same, version: '1.0.317.601' }));
    const before = readZip(base);
    expect(after.filter((e, i) => !Buffer.from(e.raw ?? []).equals(Buffer.from(before[i]?.raw ?? []))).map((e) => e.path)).toEqual(['manifest.json']);
  });

  test('lists the safe ruleset paths of the base (never a -x file)', () => {
    expect(safeRulesetPaths(extensionZip())).toEqual(['rulesets/easylist.json', 'rulesets/ubo.json']);
  });

  test('refuses an unsafe (-x) ruleset, a path outside rule_resources, and a declared file the base lacks', () => {
    const base = extensionZip();
    const v = '1.0.318.600';
    expect(() => repack({ base, rulesets: rulesets({ 'rulesets/ubo-x.json': '[]' }), version: v })).toThrow(/-x.*full release/);
    expect(() => repack({ base, rulesets: rulesets({ 'background.js': 'evil()' }), version: v })).toThrow(/not a rule_resources path/);
    const missing = extensionZip({ files: { 'rulesets/ubo-x.json': '[]', 'rulesets/easylist.json': '[]' } });
    expect(() => repack({ base: missing, rulesets: rulesets({ 'rulesets/ubo.json': '[]' }), version: v })).toThrow(/not in the base zip/);
  });

  test('refuses a version that is not later, changes the code line, or is outside the scheme', () => {
    const base = extensionZip();
    const none = new Map<string, Uint8Array>();
    expect(() => repack({ base, rulesets: none, version: '1.0.317.600' })).toThrow(/not later/);
    expect(() => repack({ base, rulesets: none, version: '1.0.316.600' })).toThrow(/not later/);
    expect(() => repack({ base, rulesets: none, version: '1.1.318.600' })).toThrow(/code line/);
    expect(() => repack({ base, rulesets: none, version: '1.0.318' })).toThrow(/scheme/);
  });

  test('a dev base (0.0.1) repacks onto its own code line 0.0', () => {
    const base = extensionZip({ version: '0.0.1' });
    expect(() => repack({ base, rulesets: new Map(), version: '0.0.318.600' })).not.toThrow();
    expect(() => repack({ base, rulesets: new Map(), version: '1.0.318.600' })).toThrow(/code line/);
  });

  test('refuses a manifest with zero or two "version" keys, or with version_name', () => {
    const two = extensionZip({ manifest: manifestText('1.0.317.600', ',"x":{"version":"2"}') });
    expect(() => repack({ base: two, rulesets: new Map(), version: '1.0.318.600' })).toThrow(/exactly one "version"/);
    const named = extensionZip({ manifest: manifestText('1.0.317.600', ',"version_name":"one"') });
    expect(() => repack({ base: named, rulesets: new Map(), version: '1.0.318.600' })).toThrow(/version_name/);
  });
});

describe('release record (E1 input)', () => {
  test('holds the version, the zip hash and one hash per file', () => {
    const zip = extensionZip();
    const r = recordOf(zip);
    expect(ReleaseRecordSchema.parse(r)).toEqual(r);
    expect(r.version).toBe('1.0.317.600');
    expect(r.zipSha256).toBe(sha256Hex(zip));
    expect(Object.keys(r.files)).toContain('rulesets/ubo.json');
    expect(r.files['catalog.json']).toBe(sha256Hex(text(CATALOG)));
  });
});
