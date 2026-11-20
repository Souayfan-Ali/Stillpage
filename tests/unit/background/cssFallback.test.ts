import { describe, expect, test } from 'vitest';
import { createWorker } from '../../../src/background/worker.js';
import { shardFileWrap } from '../../../src/core/content/shard-data.js';
import { createFakeBrowser } from '../platform/fakes/browser.js';
import { NOW, testCatalog } from '../core/reconcile/fixtures.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const wrap = shardFileWrap('ISOLATED');
const DATA = {
  v: 1, pack: 'ads', shard: 1, hosts: ['example.com', 'news.org'], entries: [{ h: [0], s: [0] }, { h: [1] }],
  selectors: ['.ad', '.promo'], styles: [['body', 'overflow:auto!important']], procedural: [], invocations: [],
};
const content = (url: string, frameId = 3) => ({ id: ID, url, origin: new URL(url).origin, tab: { id: 7 }, frameId });
const message = (registration: string) => ({ v: 1, type: 'cs/cssFallback', id: 'cs', payload: { registration } });

function setup(files: Record<string, string> = { 'cs/ads/1.js': `${wrap.prefix}${JSON.stringify(DATA)}${wrap.suffix}` }) {
  const b = createFakeBrowser({ rulesets: [], catalog: testCatalog(), now: () => NOW, packageFiles: files });
  const { handlers } = createWorker(b.ports, ID);
  return { b, send: (registration: string, sender: object) => handlers.message(message(registration), sender) };
}

describe('cs/cssFallback (P1-38)', () => {
  test('resolves the CSS from the package for the sender frame\'s host and inserts it with USER origin into that frame only', async () => {
    const { b, send } = setup();
    expect(await send('iso:ads:1', content('https://www.example.com/a'))).toEqual({ ok: true, data: { rules: 2 } });
    expect(b.insertedCss()).toEqual([{ target: { tabId: 7, frameIds: [3] }, origin: 'USER', css: '.ad{display:none!important}\nbody{overflow:auto!important}' }]);
  });

  test('a frame on a host the registration does not list is refused, and nothing is inserted', async () => {
    const { b, send } = setup();
    expect(await send('iso:ads:1', content('https://evil.test/'))).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(b.insertedCss()).toEqual([]);
  });

  test('an unknown registration, a MAIN one, or one from an extension page is refused', async () => {
    const { b, send } = setup();
    expect(await send('iso:ads:9', content('https://example.com/'))).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(await send('main:ads:1', content('https://example.com/'))).toMatchObject({ ok: false });
    expect(await send('iso:ads:1', { id: ID, url: `chrome-extension://${ID}/popup.html`, origin: `chrome-extension://${ID}` })).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(b.insertedCss()).toEqual([]);
  });

  test('a packaged file that does not parse as shard data fails closed', async () => {
    const { b, send } = setup({ 'cs/ads/1.js': 'not data' });
    expect(await send('iso:ads:1', content('https://example.com/'))).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(b.insertedCss()).toEqual([]);
  });

  test('an about:blank frame is resolved through its origin', async () => {
    const { b, send } = setup();
    expect(await send('iso:ads:1', { id: ID, url: 'about:blank', origin: 'https://news.org', tab: { id: 7 }, frameId: 5 })).toMatchObject({ ok: true });
    expect(b.insertedCss()[0]?.css).toBe('.promo{display:none!important}');
  });
});
