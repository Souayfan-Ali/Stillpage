// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { adoptRules, cssRulesFor, runCosmeticSpecific, type SheetLike } from '../../../src/content/cosmetic-specific/apply.js';
import type { ShardData } from '../../../src/core/content/shard-data.js';
import type { Hostname } from '../../../src/core/ids.js';

const shard = (over: Partial<ShardData> = {}): ShardData => ({
  v: 1, pack: 'ads', shard: 7,
  hosts: ['allowed.example.com', 'example.com', 'other.org'] as Hostname[],
  entries: [{ u: [0] }, { h: [0, 1], s: [0] }, { h: [2] }],
  selectors: ['.ad', '#banner', '.other'],
  styles: [['body', 'overflow:auto!important']],
  procedural: [], invocations: [],
  ...over,
});

/** A sheet that refuses some rules the way Chrome refuses an unknown pseudo-class. */
class FakeSheet implements SheetLike {
  readonly cssRules: string[] = [];
  insertRule(rule: string, index: number): number {
    if (rule.includes(':unknown')) throw new DOMException('bad rule', 'SyntaxError');
    this.cssRules.splice(index, 0, rule);
    return index;
  }
}

describe('cssRulesFor (P1-34)', () => {
  test('host and parent entries, minus exceptions; hide rules first, then sanitised styles', () => {
    expect(cssRulesFor([shard()], 'www.example.com' as Hostname)).toEqual([
      '.ad{display:none!important}', '#banner{display:none!important}', 'body{overflow:auto!important}',
    ]);
    expect(cssRulesFor([shard()], 'allowed.example.com' as Hostname)).toEqual(['#banner{display:none!important}', 'body{overflow:auto!important}']);
    expect(cssRulesFor([shard()], 'example.net' as Hostname)).toEqual([]);
  });

  test('re-sanitised at apply time: a selector or declaration that would leave its rule is dropped', () => {
    const tampered = shard({ selectors: ['.a{}body', '#banner', '.x'], styles: [['body', 'background:url(//x)']] });
    expect(cssRulesFor([tampered], 'example.com' as Hostname)).toEqual(['#banner{display:none!important}']);
  });

  test('selectors shared by two packs are applied once', () => {
    const b = shard({ pack: 'trackers', hosts: ['example.com'] as Hostname[], entries: [{ h: [0] }], selectors: ['.ad'], styles: [] });
    expect(cssRulesFor([shard(), b], 'example.com' as Hostname).filter((r) => r.startsWith('.ad{'))).toHaveLength(1);
  });
});

describe('adoptRules: one rule at a time, a bad rule never swallows the rest', () => {
  test('every good rule is inserted around a refused one, then the sheet is adopted once', () => {
    const doc = { adoptedStyleSheets: [] as unknown[] };
    const sheet = new FakeSheet();
    expect(adoptRules(doc, ['.a{display:none!important}', '.b:unknown{display:none!important}', '.c{display:none!important}'], () => sheet)).toBe(true);
    expect(sheet.cssRules).toEqual(['.a{display:none!important}', '.c{display:none!important}']);
    expect(doc.adoptedStyleSheets).toEqual([sheet]);
  });

  test('page-adopted sheets are kept, ours is appended', () => {
    const page = new FakeSheet();
    const doc = { adoptedStyleSheets: [page] as unknown[] };
    const ours = new FakeSheet();
    adoptRules(doc, ['.a{display:none!important}'], () => ours);
    expect(doc.adoptedStyleSheets).toEqual([page, ours]);
  });

  test('a document without adoptedStyleSheets reports false and adopts nothing', () => {
    expect(adoptRules({}, ['.a{display:none!important}'], () => new FakeSheet())).toBe(false);
  });
});

describe('runCosmeticSpecific', () => {
  const env = (queue: unknown[], hostname = 'www.example.com') => {
    const scope: Record<string, unknown> = { __cs_q: queue };
    const doc = { adoptedStyleSheets: [] as unknown[] };
    const fallback = vi.fn();
    return { scope, doc, fallback, run: () => runCosmeticSpecific({ scope, document: doc, location: { hostname, origin: `https://${hostname}` }, newSheet: () => new FakeSheet(), fallback }) };
  };

  test('takes the queue, adopts one sheet, sends nothing', () => {
    const e = env([shard()]);
    expect(e.run()).toBe(3);
    expect('__cs_q' in e.scope).toBe(false);
    expect(e.doc.adoptedStyleSheets).toHaveLength(1);
    expect(e.fallback).not.toHaveBeenCalled();
  });

  test('a frame with no matching host gets no sheet; the queue is still removed', () => {
    const e = env([shard()], 'unrelated.net');
    expect(e.run()).toBe(0);
    expect(e.doc.adoptedStyleSheets).toHaveLength(0);
    expect('__cs_q' in e.scope).toBe(false);
  });

  test('without adoptedStyleSheets the worker is asked for the CSS by registration id, never with selector text (P1-38)', () => {
    const scope: Record<string, unknown> = { __cs_q: [shard(), shard({ shard: 9, hosts: ['x.net'] as Hostname[], entries: [{ h: [0] }] })] };
    const fallback = vi.fn();
    runCosmeticSpecific({ scope, document: {}, location: { hostname: 'example.com', origin: 'https://example.com' }, newSheet: () => new FakeSheet(), fallback });
    expect(fallback.mock.calls).toEqual([['iso:ads:7']]);
  });

  test('the real jsdom document (no adoptedStyleSheets) takes the fallback path', () => {
    const fallback = vi.fn();
    runCosmeticSpecific({ scope: { __cs_q: [shard()] }, document, location: { hostname: 'example.com', origin: 'https://example.com' }, newSheet: () => new CSSStyleSheet(), fallback });
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
