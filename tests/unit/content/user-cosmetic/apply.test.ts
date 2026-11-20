import { describe, expect, test, vi } from 'vitest';
import { runUserCosmetic, type UserCosmeticEnv } from '../../../../src/content/user-cosmetic/apply.js';

/** `replaceSync` as Chrome parses it: a rule the engine refuses is dropped, the others stay. */
class FakeSheet {
  cssRules: string[] = [];
  replaceSync(text: string): void {
    this.cssRules = text === '' ? [] : text.split('\n').filter((rule) => !rule.includes(':bogus'));
  }
}

function env(store: Readonly<Record<string, unknown>>, over: Partial<UserCosmeticEnv> = {}) {
  const doc: { adoptedStyleSheets?: unknown[] } = { adoptedStyleSheets: [] };
  const read = vi.fn((keys: readonly string[]) => Promise.resolve(Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))));
  const e: UserCosmeticEnv = { document: doc, location: { hostname: 'a.news.example.com', protocol: 'https:' }, read, newSheet: () => new FakeSheet(), ...over };
  return { e, doc, read };
}

describe('user-cosmetic (P2-20): reads uf:<host> and parents, applies display:none only', () => {
  test('host and parents, de-duplicated, one adopted sheet', async () => {
    const { e, doc, read } = env({ 'uf:news.example.com': { v: 1, s: ['.ad', '#top'] }, 'uf:a.news.example.com': { v: 1, s: ['.ad'] } });
    expect(await runUserCosmetic(e)).toBe(2);
    expect(read).toHaveBeenCalledWith(['uf:a.news.example.com', 'uf:news.example.com', 'uf:example.com', 'uf:com']);
    expect((doc.adoptedStyleSheets?.[0] as FakeSheet).cssRules).toEqual(['#top{display:none!important}', '.ad{display:none!important}']);
  });

  test('a tampered entry cannot add declarations or escape the rule', async () => {
    const { e, doc } = env({ 'uf:news.example.com': { v: 1, s: ['.x{color:red} body', 'body{background:url(x)}', '.ok', 'a:bogus'] } });
    expect(await runUserCosmetic(e)).toBe(2);
    expect((doc.adoptedStyleSheets?.[0] as FakeSheet).cssRules).toEqual(['.ok{display:none!important}']);
  });

  test.each([
    ['nothing stored', {}],
    ['malformed entry', { 'uf:news.example.com': 'body' }],
  ])('%s → nothing adopted', async (_name, store) => {
    const { e, doc } = env(store);
    expect(await runUserCosmetic(e)).toBe(0);
    expect(doc.adoptedStyleSheets).toEqual([]);
  });

  test('no web host or no adoptable document → nothing, and no read for a non-web frame', async () => {
    const { e, read } = env({}, { location: { hostname: '', protocol: 'about:' } });
    expect(await runUserCosmetic(e)).toBe(0);
    expect(read).not.toHaveBeenCalled();
    const stored = { 'uf:news.example.com': { v: 1, s: ['.ad'] } };
    const noAdopt = env(stored, { document: {} });
    expect(await runUserCosmetic(noAdopt.e)).toBe(0);
  });

  test('a failing read applies nothing', async () => {
    const { e } = env({}, { read: () => Promise.reject(new Error('gone')) });
    expect(await runUserCosmetic(e)).toBe(0);
  });
});
