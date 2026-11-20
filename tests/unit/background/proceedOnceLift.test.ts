/**
 * D-55 / D-55a through the worker: "Proceed once" on a lifted destination (its redirect live at
 * 5,000,000) adds one exact-URL allow at 5,000,001 for that tab; on any other destination the host + tab
 * rule at 3. A refused address adds nothing. A lifted rule is dropped once its host stops being lifted.
 */
import { describe, expect, test } from 'vitest';
import { createWorker } from '../../../src/background/worker.js';
import type { RulesetId } from '../../../src/core/ids.js';
import { POPUP_LIFT_PRIORITY, POPUP_PRIORITY } from '../../../src/core/limits.js';
import { createFakeBrowser } from '../platform/fakes/browser.js';
import { NOW, testCatalog } from '../core/reconcile/fixtures.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${ID}`;
const TAB = 7;
const POPUP = { id: ID, url: `${ORIGIN}/popup.html`, origin: ORIGIN };
const rulesets = ['ubo', 'ubo-x', 'easyprivacy', 'cookies', 'cookies-x', 'popups'].map((id) => ({ id: id as RulesetId, enabled: !id.endsWith('-x'), regexCount: 1 }));
const LISTS = {
  'popup-destinations.json': '["a-ads.com","pop.test"]',
  'popup-strict-sites.json': '[]',
  'popup-lifted.json': '{"ubo":["a-ads.com"]}',
};

let counter = 0;
const msg = (type: string, payload: unknown): unknown => ({ v: 1, type, id: `m${String((counter += 1))}`, payload });
const blocked = (fragment: string, tabId = TAB): object => ({ id: ID, url: `${ORIGIN}/blocked.html#${fragment}`, origin: ORIGIN, tab: { id: tabId }, frameId: 0 });

async function setup() {
  const b = createFakeBrowser({ rulesets, catalog: testCatalog(), now: () => NOW, packageFiles: LISTS });
  b.setTab(TAB, 'https://news.example/');
  const worker = createWorker(b.ports, ID);
  const send = (type: string, payload: unknown, sender: object = POPUP): Promise<unknown> => worker.handlers.message(msg(type, payload), sender);
  await worker.reconciler.request('test');
  return { b, worker, send };
}

describe('c/proceedOnce on a lifted destination', () => {
  test('the redirect of a lifted host is live at 5,000,000', async () => {
    const { b } = await setup();
    const redirects = (await b.ports.dnr.getDynamicRules()).filter((r) => r.action.type === 'redirect');
    expect(redirects.map((r) => [r.priority, r.condition.requestDomains])).toEqual([[POPUP_LIFT_PRIORITY.redirect, ['a-ads.com']], [POPUP_PRIORITY.redirect, ['pop.test']]]);
  });

  test('adds one exact-URL allow (fragment dropped) at 5,000,001 in that tab; a reconcile keeps it', async () => {
    const s = await setup();
    expect(await s.send('c/proceedOnce', { hostname: 'a-ads.com' }, blocked('https://a-ads.com/landing?z=1#top'))).toEqual({ ok: true, data: null });
    const rules = await s.b.ports.dnr.getSessionRules();
    expect(rules).toEqual([{
      id: 1,
      priority: POPUP_LIFT_PRIORITY.allow,
      action: { type: 'allow' },
      condition: { urlFilter: '|https://a-ads.com/landing?z=1|', isUrlFilterCaseSensitive: true, requestDomains: ['a-ads.com'], tabIds: [TAB], resourceTypes: ['main_frame'] },
    }]);
    await s.worker.reconciler.request('test');
    expect(await s.b.ports.dnr.getSessionRules()).toEqual(rules);
  });

  test('a second address on the same host in the same tab replaces the rule', async () => {
    const s = await setup();
    await s.send('c/proceedOnce', { hostname: 'a-ads.com' }, blocked('https://a-ads.com/one'));
    await s.send('c/proceedOnce', { hostname: 'a-ads.com' }, blocked('https://a-ads.com/two'));
    expect((await s.b.ports.dnr.getSessionRules()).map((r) => r.condition.urlFilter)).toEqual(['|https://a-ads.com/two|']);
  });

  test('an address the exact-URL rule cannot name is refused and adds nothing', async () => {
    const s = await setup();
    expect(await s.send('c/proceedOnce', { hostname: 'a-ads.com' }, blocked('https://a-ads.com/a*b'))).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await s.b.ports.dnr.getSessionRules()).toEqual([]);
  });

  test('a destination that is not lifted keeps the host + tab rule at 3', async () => {
    const s = await setup();
    await s.send('c/proceedOnce', { hostname: 'pop.test' }, blocked('https://pop.test/x'));
    expect(await s.b.ports.dnr.getSessionRules()).toEqual([
      { id: 1, priority: POPUP_PRIORITY.allow, action: { type: 'allow' }, condition: { requestDomains: ['pop.test'], tabIds: [TAB], resourceTypes: ['main_frame'] } },
    ]);
  });

  test('turning the justifying pack off ends the lift: the lifted rule goes, Proceed once falls back to host + tab', async () => {
    const s = await setup();
    await s.send('c/proceedOnce', { hostname: 'a-ads.com' }, blocked('https://a-ads.com/landing'));
    expect(await s.send('c/setPack', { pack: 'ads', enabled: false })).toMatchObject({ ok: true });
    expect(await s.b.ports.dnr.getSessionRules()).toEqual([]);
    const redirects = (await s.b.ports.dnr.getDynamicRules()).filter((r) => r.action.type === 'redirect');
    expect(redirects.map((r) => r.priority)).toEqual([POPUP_PRIORITY.redirect]);
    await s.send('c/proceedOnce', { hostname: 'a-ads.com' }, blocked('https://a-ads.com/landing'));
    expect((await s.b.ports.dnr.getSessionRules()).map((r) => r.priority)).toEqual([POPUP_PRIORITY.allow]);
  });
});
