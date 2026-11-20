import { describe, expect, test } from 'vitest';
import type { ListConfig } from '../../../../compiler/config/schema.js';
import { parseList } from '../../../../compiler/parse/parse-list.js';

const list = (format: 'adblock' | 'hosts', trusted = false): ListConfig => ({
  id: 'l', title: 'L', url: 'https://x.example/l.txt', licence: 'CC0-1.0', licenceState: 'cleared', trusted, format,
  homepage: 'https://x.example/',
});

describe('parseList', () => {
  test('classifies adblock lines, keeps source positions and the trust flag, drops comments', () => {
    const r = parseList(list('adblock', true), '! header\n||ads.example^\n!#if env_firefox\n||ff.example^\n!#endif\nsite.example##.ad\n');
    expect(r.entries.map((e) => [e.kind, e.source.line, e.source.text, e.trusted])).toEqual([
      ['network', 2, '||ads.example^', true],
      ['cosmetic.specific', 6, 'site.example##.ad', true],
    ]);
    expect(r.counts.comment).toBe(2);
    expect(r.discardedLines).toBe(1);
  });

  test('hosts lists: one network.host entry per line; housekeeping names and comments ignored', () => {
    const r = parseList(list('hosts'), '# Title\n0.0.0.0 bad.example\n127.0.0.1 localhost\n0.0.0.0 worse.example\nnot a host line here\n');
    expect(r.entries.map((e) => e.kind)).toEqual(['network.host', 'network.host', 'invalid']);
    expect(r.counts['network.host']).toBe(2);
  });

  test('fails on !#include', () => {
    expect(() => parseList(list('adblock'), 'a\n!#include sub.txt')).toThrow(/line 2: !#include/);
  });
});
