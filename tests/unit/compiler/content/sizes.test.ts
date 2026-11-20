import { describe, expect, test } from 'vitest';
import { oversizedPackCode, scriptletSizes } from '../../../../compiler/content/sizes.js';
import { shardFileWrap } from '../../../../src/core/content/shard-data.js';

const iso = shardFileWrap('ISOLATED');
const data = (o: unknown) => `${iso.prefix}${JSON.stringify(o)}${iso.suffix}`;

describe('scriptlet size accounting (D-22)', () => {
  test('counts MAIN files and common tables whole, and from ISOLATED shards only the scriptlet share', () => {
    const files = new Map([
      ['scriptlets/ads/main/0.js', 'MAINDATA'],
      ['scriptlets/ads/isolated/common.js', 'COMMON'],
      ['scriptlets/ads.main.js', 'code-main'],
      ['scriptlets/ads.isolated.js', 'code-iso'],
      ['cosmetic/ads/0.js', data({ v: 1, pack: 'ads', shard: 0, hosts: ['a.com', 'b.com'], entries: [{ h: [0] }, { j: [0] }], selectors: ['.x'], styles: [], procedural: [], invocations: [[0, 'q']] })],
      ['scriptlets/other/main/0.js', 'NOT COUNTED'],
    ]);
    const s = scriptletSizes(files, ['ads']);
    expect(s.dispatch.raw).toBe(Buffer.byteLength('COMMONMAINDATA[[0,"q"]]"b.com"{"j":[0]}'));
    expect(s.code.raw).toBe('code-maincode-iso'.length);
    expect(Object.keys(s.code.byPack)).toEqual(['ads']);
  });

  test('P2-47: the per-pack code gate covers every pack given, optional ones included', () => {
    const files = new Map([
      ['scriptlets/ads.main.js', 'small'],
      ['scriptlets/annoy-overlays.main.js', 'x'.repeat(10) + Array.from({ length: 4000 }, (_, i) => String(i * 7919)).join(';')],
      ['scriptlets/reg-ja.isolated.js', 'tiny'],
    ]);
    const limit = 200;
    expect(oversizedPackCode(files, ['ads', 'annoy-overlays', 'reg-ja', 'gpc'], limit)).toEqual([expect.stringMatching(/^scriptlet code of annoy-overlays: \d+ B gzip > 200$/)]);
    expect(oversizedPackCode(files, ['ads', 'reg-ja'], limit)).toEqual([]);
  });
});
