import { describe, expect, test } from 'vitest';
import type { RulesetId } from '../../../src/core/ids.js';
import { createWorker } from '../../../src/background/worker.js';
import { MATCHED_CACHE_MS, matchedKey } from '../../../src/background/matched.js';
import { createFakeBrowser, type FakeBrowser } from '../platform/fakes/browser.js';
import { NOW, testCatalog } from '../core/reconcile/fixtures.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const POPUP = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/popup.html?tabId=7`, origin: `chrome-extension://${RUNTIME_ID}` };
const TAB = 7;
const BUCKETS = JSON.stringify({
  schema: 1,
  buckets: [
    { id: 'google', name: 'Google', category: 'company' },
    { id: 'other:ads', name: 'Other', category: 'ads' },
    { id: 'other:popup', name: 'Other', category: 'popup' },
  ],
  rulesets: { ubo: [[1, 0], [3, 1], [9, -1]] },
});

let counter = 0;
const msg = (type: string, payload: unknown): unknown => ({ v: 1, type, id: `m${String((counter += 1))}`, payload });

function setup(files: Readonly<Record<string, string>> = { 'buckets.json': BUCKETS }) {
  let clock = NOW;
  const b = createFakeBrowser({
    rulesets: [{ id: 'ubo' as RulesetId, enabled: true, regexCount: 0 }],
    catalog: testCatalog(),
    now: () => clock,
    packageFiles: files,
  });
  b.setTab(TAB, 'https://news.example.com/a?b=1');
  const { handlers } = createWorker(b.ports, RUNTIME_ID);
  const ask = (sender: object = POPUP, tabId = TAB): Promise<unknown> => handlers.message(msg('q/matchedRules', { tabId }), sender);
  return { b, ask, tick: (ms: number) => (clock += ms) };
}

const calls = (b: FakeBrowser): number => b.calls().filter((c) => c === 'dnr.getMatchedRules').length;

describe('q/matchedRules (P2-11)', () => {
  test('counts per bucket for the tab; no URL in the answer', async () => {
    const { b, ask } = setup();
    b.setMatchedRules(TAB, [{ rulesetId: 'ubo', ruleId: 1 }, { rulesetId: 'ubo', ruleId: 4 }, { rulesetId: 'ubo', ruleId: 1 }]);
    const answer = await ask();
    expect(answer).toMatchObject({
      ok: true,
      data: { kind: 'counts', stale: false, total: 3, groups: [{ category: 'ads', count: 3, buckets: [{ id: 'google', name: 'Google', count: 2 }, { id: 'other:ads', count: 1 }] }] },
    });
    expect(JSON.stringify(answer)).not.toContain('news.example.com');
  });

  test('cached per tab for 30 s, then asked again', async () => {
    const { b, ask, tick } = setup();
    b.setMatchedRules(TAB, [{ rulesetId: 'ubo', ruleId: 1 }]);
    await ask();
    b.setMatchedRules(TAB, [{ rulesetId: 'ubo', ruleId: 1 }, { rulesetId: 'ubo', ruleId: 2 }]);
    tick(MATCHED_CACHE_MS - 1);
    expect(await ask()).toMatchObject({ data: { total: 1 } });
    expect(calls(b)).toBe(1);
    tick(1);
    expect(await ask()).toMatchObject({ data: { total: 2 } });
    expect(calls(b)).toBe(2);
  });

  test('another page on the same tab never reuses the previous page cache', async () => {
    const { b, ask } = setup();
    b.setMatchedRules(TAB, [{ rulesetId: 'ubo', ruleId: 1 }]);
    await ask();
    b.setTab(TAB, 'https://other.example.org/');
    b.setMatchedRules(TAB, null);
    expect(await ask()).toEqual({ ok: true, data: { kind: 'unavailable' } });
  });

  test('a tab whose address Chrome hides is never cached (review HIGH: every page would share one key)', async () => {
    const { b, ask } = setup();
    b.setTab(TAB, null);
    b.setMatchedRules(TAB, [{ rulesetId: 'ubo', ruleId: 1 }]);
    await ask();
    b.setMatchedRules(TAB, [{ rulesetId: 'ubo', ruleId: 1 }, { rulesetId: 'ubo', ruleId: 2 }]);
    expect(await ask()).toMatchObject({ data: { total: 2 } });
    expect(await b.ports.session.get(matchedKey(TAB))).toBeUndefined();
  });

  test('the cache stores a hash of the address, never the address', async () => {
    const { b, ask } = setup();
    b.setMatchedRules(TAB, [{ rulesetId: 'ubo', ruleId: 1 }]);
    await ask();
    const stored = JSON.stringify(await b.ports.session.get(matchedKey(TAB)));
    expect(stored).not.toContain('news.example.com');
    expect(stored).toMatch(/"page":"[0-9a-f]{64}"/);
  });

  test('without an activeTab grant: unavailable, or the last answer for the page marked stale', async () => {
    const { b, ask, tick } = setup();
    expect(await ask()).toEqual({ ok: true, data: { kind: 'unavailable' } });
    b.setMatchedRules(TAB, [{ rulesetId: 'ubo', ruleId: 1 }]);
    await ask();
    b.setMatchedRules(TAB, null);
    tick(MATCHED_CACHE_MS);
    expect(await ask()).toMatchObject({ ok: true, data: { kind: 'counts', stale: true, total: 1 } });
    expect(b.logs().some((l) => l.startsWith('warn: getMatchedRules failed'))).toBe(true);
  });

  test('our own rules: allow rules dropped, the blocked-page redirect counted as a pop-up', async () => {
    const { b, ask } = setup();
    await b.ports.dnr.updateDynamicRules({
      removeRuleIds: [],
      addRules: [
        { id: 1_000_001, priority: 15_000_000, action: { type: 'allowAllRequests' }, condition: { requestDomains: ['x.example'], resourceTypes: ['main_frame'] } },
        { id: 1_200_050, priority: 2, action: { type: 'redirect', redirect: { regexSubstitution: 'chrome-extension://x/blocked.html#\\0' } }, condition: { regexFilter: '^https?://.*', requestDomains: ['ad.example'], resourceTypes: ['main_frame'] } },
      ],
    });
    b.setMatchedRules(TAB, [{ rulesetId: '_dynamic', ruleId: 1_000_001 }, { rulesetId: '_dynamic', ruleId: 1_200_050 }, { rulesetId: '_session', ruleId: 9 }]);
    expect(await ask()).toMatchObject({ data: { total: 1, groups: [{ category: 'popup', count: 1 }], rules: [{ rulesetId: '_dynamic', ruleId: 1_200_050 }] } });
  });

  test('a broken buckets.json counts everything as Other and logs it', async () => {
    for (const files of [{ 'buckets.json': '{"schema":2}' }, {}]) {
      const { b, ask } = setup(files);
      b.setMatchedRules(TAB, [{ rulesetId: 'ubo', ruleId: 1 }]);
      expect(await ask()).toMatchObject({ data: { total: 1, groups: [{ category: 'other', buckets: [{ id: 'other:other' }] }] } });
      expect(b.logs().some((l) => l.startsWith('error: buckets.json'))).toBe(true);
    }
  });

  test('a garbled cache entry is ignored; a cache write failure still answers', async () => {
    const { b, ask } = setup();
    await b.ports.session.set(matchedKey(TAB), { url: 'https://news.example.com/a?b=1', summary: { kind: 'counts', total: 'x' } });
    b.setMatchedRules(TAB, [{ rulesetId: 'ubo', ruleId: 1 }]);
    b.failNext('session.set');
    expect(await ask()).toMatchObject({ ok: true, data: { total: 1 } });
  });

  test('refused from other pages and content scripts; unknown tab not-found; tabs failure internal', async () => {
    const { b, ask } = setup();
    expect(await ask({ ...POPUP, url: `chrome-extension://${RUNTIME_ID}/blocked.html`, tab: { id: 3 }, frameId: 0 })).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await ask({ ...POPUP, url: `chrome-extension://${RUNTIME_ID}/dashboard.html` })).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await ask({ id: RUNTIME_ID, url: 'https://news.test/', tab: { id: 7 }, frameId: 0 })).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    b.failNext('tabs.get');
    expect(await ask()).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(await ask(POPUP, 99)).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });
});
