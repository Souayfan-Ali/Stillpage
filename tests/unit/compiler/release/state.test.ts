import { describe, expect, test } from 'vitest';
import { recordOf, sha256Hex } from '../../../../compiler/release/record.js';
import { checksums, idmapAssets, rulesetState } from '../../../../compiler/release/state.js';
import { extensionZip, text } from './fixtures.js';

const base = extensionZip();
const candidate = extensionZip({ version: '1.0.318.600' });

describe('ruleset-state commit and release assets (tooling notes §7, P2-05)', () => {
  test('one tag rules/<version> holding the lock, ledgers, counts and the release record with its base', () => {
    const s = rulesetState({
      lock: '{"schema":1}\n', counts: '{"schema":1,"slots":{}}\n', ledgers: new Map([['ubo', '{"u":1}\n'], ['easylist', '{"e":1}\n']]),
      candidate: recordOf(candidate), base: recordOf(base),
    });
    expect(s.tag).toBe('rules/1.0.318.600');
    expect([...s.files.keys()]).toEqual(['ledger/easylist.json', 'ledger/ubo.json', 'lists.lock.json', 'release.json', 'ruleset-counts.json']);
    const release = JSON.parse(s.files.get('release.json') ?? '{}') as { record: { version: string }; repackedFrom: { version: string; zipSha256: string } };
    expect(release.record.version).toBe('1.0.318.600');
    expect(release.repackedFrom).toEqual({ version: '1.0.317.600', zipSha256: sha256Hex(base) });
    expect(s.message).toMatch(/^rules 1\.0\.318\.600 \(repacked from 1\.0\.317\.600\)/);
  });

  test('refuses a slot name that is not a plain ruleset id', () => {
    expect(() => rulesetState({ lock: '', counts: '', ledgers: new Map([['../x', '{}']]), candidate: recordOf(candidate), base: recordOf(base) })).toThrow(/ruleset id/);
  });

  test('checksums are sha256sum-compatible and sorted by name', () => {
    const sums = checksums(new Map([['b.zip', text('b')], ['a.json', text('a')]]));
    expect(sums).toBe(`${sha256Hex(text('a'))}  a.json\n${sha256Hex(text('b'))}  b.zip\n`);
    expect(() => checksums(new Map([['a b', text('x')]]))).toThrow(/asset name/);
  });
});

describe('full-release version from the tag (P2-06)', () => {
  test('v<MAJOR>.<MINOR> tags give the code line; anything else is refused', async () => {
    const { codeLineOfTag } = await import('../../../../compiler/release/state.js');
    expect(codeLineOfTag('v1.0')).toEqual({ major: 1, minor: 0 });
    expect(codeLineOfTag('refs/tags/v2.13')).toEqual({ major: 2, minor: 13 });
    for (const bad of ['v1', 'v1.0.3', '1.0', 'v01.0', 'vx.y', 'v1.0-rc']) expect(() => codeLineOfTag(bad)).toThrow(/tag/);
  });
});

describe('idmap release assets (P2-16 follow-up)', () => {
  test('compiler id maps become idmap-<rulesetId>.json, sorted; anything else is ignored; checksums accept them', () => {
    const bytes = new TextEncoder().encode('{}');
    const assets = idmapAssets(new Map([['ubo.json', bytes], ['easylist-x.json', bytes], ['../evil.json', bytes], ['Upper.json', bytes], ['notes.txt', bytes]]));
    expect([...assets.keys()]).toEqual(['idmap-easylist-x.json', 'idmap-ubo.json']);
    expect(checksums(assets)).toMatch(/ {2}idmap-easylist-x\.json\n.* {2}idmap-ubo\.json\n$/);
  });
});
