import { describe, expect, test } from 'vitest';
import type { RulesetId } from '../../../src/core/ids.js';
import { createWorker } from '../../../src/background/worker.js';
import { NOTICE_KEY, SETTINGS_KEY } from '../../../src/background/settingsStore.js';
import { createFakeBrowser, type FakeBrowser } from '../platform/fakes/browser.js';
import { NOW, settings, testCatalog } from '../core/reconcile/fixtures.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const POPUP = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/popup.html?tabId=7`, origin: `chrome-extension://${RUNTIME_ID}` };
const CONTENT = { id: RUNTIME_ID, url: 'https://news.test/', origin: 'https://news.test', tab: { id: 7 }, frameId: 0 };
const TAB = 7;
const HOST = 'news.example.com';
const rulesets = ['ubo', 'ubo-x', 'easyprivacy', 'cookies', 'cookies-x', 'popups'].map((id) => ({
  id: id as RulesetId,
  enabled: !id.endsWith('-x'),
  regexCount: 1,
}));

let counter = 0;
const msg = (type: string, payload: unknown): unknown => ({ v: 1, type, id: `m${String((counter += 1))}`, payload });

function setup(): { b: FakeBrowser; send: (type: string, payload: unknown, sender?: object) => Promise<unknown> } {
  const b = createFakeBrowser({ rulesets, catalog: testCatalog(), now: () => NOW });
  b.setTab(TAB, `https://${HOST}/story?id=1`);
  const { handlers } = createWorker(b.ports, RUNTIME_ID);
  return { b, send: (type, payload, sender = POPUP) => handlers.message(msg(type, payload), sender) };
}

const storedLevels = async (b: FakeBrowser): Promise<unknown> => ((await b.ports.vault.get(SETTINGS_KEY)) as { siteLevels: unknown }).siteLevels;

describe('q/tabState', () => {
  test('answers for the tab the panel names: host, level, access; not ready before the first reconcile', async () => {
    const { send } = setup();
    expect(await send('q/tabState', { tabId: TAB })).toEqual({
      ok: true,
      data: { page: 'web', host: HOST, level: 'standard', setOn: null, pausedUntil: null, access: 'all', ready: false, settingsReset: false, theme: 'system', lastRun: 'none', site: { ownLevel: null, popupPolicy: null, pausedUntil: null }, packs: ['ads', 'trackers', 'popups'], popupMode: 'off', popupGuard: true, hidden: [] },
    });
  });

  test('ready after a reconcile; settings-reset notice shown while one is waiting', async () => {
    const { b, send } = setup();
    await send('c/reconcile', {});
    await b.ports.vault.set(NOTICE_KEY, { kind: 'settings-reset', reason: 'invalid', at: NOW });
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ ok: true, data: { ready: true, settingsReset: true } });
  });

  test('levels come from the vault with inheritance; access follows the grants', async () => {
    const { b, send } = setup();
    await b.ports.vault.set(SETTINGS_KEY, settings({ siteLevels: { 'example.com': 'light' } }));
    b.setSiteAccess({ origins: ['https://*.example.com/*'] });
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { level: 'light', setOn: 'example.com', access: 'site' } });
  });

  test('without host access Chrome hides the address: reduced, no host', async () => {
    const { b, send } = setup();
    b.setSiteAccess({ origins: [] });
    b.setTab(TAB, null);
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { page: 'web', host: null, access: 'none' } });
  });

  test('an unknown tab, an unreadable vault, and a content-script sender are refused', async () => {
    const { b, send } = setup();
    expect(await send('q/tabState', { tabId: 99 })).toMatchObject({ ok: false, error: { code: 'not-found' } });
    b.failNext('vault.get');
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(await send('q/tabState', { tabId: TAB }, CONTENT)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    b.failNext('tabs.get');
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  test('P2-47 follow-up: reads the pack summary, never the full catalog with its host lists (cold panel)', async () => {
    const { b, send } = setup();
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ ok: true, data: { packs: ['ads', 'trackers', 'popups'] } });
    expect(b.calls()).toContain('catalog.readPacks');
    expect(b.calls()).not.toContain('catalog.read');
    b.failNext('catalog.readPacks');
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});

describe('panel pages only (security review MEDIUM-1)', () => {
  test('another extension page of ours (blocked.html) may not ask about a tab or change a level', async () => {
    const { send } = setup();
    const blocked = { ...POPUP, url: `chrome-extension://${RUNTIME_ID}/blocked.html`, tab: { id: 3 }, frameId: 0 };
    expect(await send('q/tabState', { tabId: TAB }, blocked)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await send('c/setSiteLevel', { hostname: HOST, level: 'off' }, blocked)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await send('c/reconcile', {}, blocked)).toMatchObject({ ok: true });
  });
});

describe('c/setSiteLevel', () => {
  test('stores the level, reconciles, and the panel reads it back', async () => {
    const { b, send } = setup();
    expect(await send('c/setSiteLevel', { hostname: HOST, level: 'off' })).toEqual({ ok: true, data: { status: 'applying', skippedPacks: [], site: { ownLevel: 'off', popupPolicy: null, pausedUntil: null } } }); // D-25: answered once the DNR switch is in
    expect(await storedLevels(b)).toEqual({ [HOST]: 'off' });
    const dynamic = await b.ports.dnr.getDynamicRules();
    expect(dynamic.some((r) => r.action.type === 'allowAllRequests' && r.condition.requestDomains?.includes(HOST))).toBe(true);
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { level: 'off', setOn: HOST } });
  });

  test('inherit after a pause ("Resume now") clears the pause and turns the host back on', async () => {
    const { b, send } = setup();
    await b.ports.vault.set(SETTINGS_KEY, settings({ pauses: { [HOST]: NOW + 60_000 } }));
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { level: 'off', pausedUntil: NOW + 60_000 } });
    expect(await send('c/setSiteLevel', { hostname: HOST, level: 'inherit' })).toMatchObject({ ok: true });
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { level: 'standard', pausedUntil: null } });
    expect(b.alarms()).toEqual({});
  });

  test('concurrent commands are serialised: neither change is lost', async () => {
    const { b, send } = setup();
    await Promise.all([send('c/setSiteLevel', { hostname: HOST, level: 'light' }), send('c/setSiteLevel', { hostname: 'other.org', level: 'thorough' })]);
    expect(await storedLevels(b)).toEqual({ [HOST]: 'light', 'other.org': 'thorough' });
  });

  test('refused from a content script; refused (nothing written) when the vault cannot be read', async () => {
    const { b, send } = setup();
    expect(await send('c/setSiteLevel', { hostname: HOST, level: 'off' }, CONTENT)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    b.failNext('vault.get');
    expect(await send('c/setSiteLevel', { hostname: HOST, level: 'off' })).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(await b.ports.vault.get(SETTINGS_KEY)).toBeUndefined();
  });

  test('a failed reconcile after a successful save is reported as a failure', async () => {
    const { b, send } = setup();
    b.failNext('catalog.read');
    expect(await send('c/setSiteLevel', { hostname: HOST, level: 'light' })).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(await storedLevels(b)).toEqual({ [HOST]: 'light' });
  });
});

describe('P2-10: pause menu, dismiss notice, last run (D-31, D-32)', () => {
  const siteOf = async (b: FakeBrowser): Promise<unknown> => ((await b.ports.vault.get(SETTINGS_KEY)));

  test('c/pauseSite 30: paused until now + 30 min, answered with the site as stored, alarm set', async () => {
    const { b, send } = setup();
    expect(await send('c/pauseSite', { hostname: HOST, minutes: 30 })).toEqual({
      ok: true,
      data: { status: 'applying', skippedPacks: [], site: { ownLevel: null, popupPolicy: null, pausedUntil: NOW + 30 * 60_000 } },
    });
    expect(await siteOf(b)).toMatchObject({ pauses: { [HOST]: { until: NOW + 30 * 60_000 } } });
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { level: 'off', pausedUntil: NOW + 30 * 60_000 } });
    await send('c/reconcile', {});
    expect(b.alarms()).toEqual({ 'pause-expiry': NOW + 30 * 60_000 });
  });

  test('c/pauseSite null: Off on this site, not a pause', async () => {
    const { b, send } = setup();
    expect(await send('c/pauseSite', { hostname: HOST, minutes: null })).toMatchObject({ ok: true, data: { site: { ownLevel: 'off', pausedUntil: null } } });
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { level: 'off', pausedUntil: null, setOn: HOST } });
    expect(await siteOf(b)).toMatchObject({ pauses: {}, siteLevels: { [HOST]: 'off' } });
  });

  test('c/pauseSite refuses other lengths, content scripts and other extension pages', async () => {
    const { send } = setup();
    const blocked = { ...POPUP, url: `chrome-extension://${RUNTIME_ID}/blocked.html`, tab: { id: 3 }, frameId: 0 };
    const dashboard = { ...POPUP, url: `chrome-extension://${RUNTIME_ID}/dashboard.html` };
    expect(await send('c/pauseSite', { hostname: HOST, minutes: 15 })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await send('c/pauseSite', { hostname: HOST, minutes: 30 }, CONTENT)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await send('c/pauseSite', { hostname: HOST, minutes: 30 }, blocked)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await send('c/pauseSite', { hostname: HOST, minutes: 30 }, dashboard)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
  });

  test('c/pauseSite over the pause cap is refused and nothing is stored', async () => {
    const { b, send } = setup();
    const full = Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`s${String(i)}.example`, NOW + 60_000]));
    await b.ports.vault.set(SETTINGS_KEY, settings({ pauses: full }));
    expect(await send('c/pauseSite', { hostname: HOST, minutes: 30 })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(Object.keys(((await siteOf(b)) as { pauses: object }).pauses)).not.toContain(HOST);
  });

  test('c/dismissNotice clears the settings-reset notice; a later settings write never does', async () => {
    const { b, send } = setup();
    await b.ports.vault.set(NOTICE_KEY, { kind: 'settings-reset', reason: 'invalid', at: NOW });
    await send('c/setSiteLevel', { hostname: HOST, level: 'light' });
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { settingsReset: true } });
    expect(await send('c/dismissNotice', {})).toEqual({ ok: true, data: { dismissed: true } });
    expect(await b.ports.vault.get(NOTICE_KEY)).toEqual({ kind: 'settings-reset', reason: 'invalid', at: NOW, dismissedAt: NOW });
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { settingsReset: false } });
    // The next valid write drops the dismissed notice, so a later reset is shown again.
    await send('c/setSiteLevel', { hostname: HOST, level: 'thorough' });
    expect(await b.ports.vault.get(NOTICE_KEY)).toBeUndefined();
    expect(await send('c/dismissNotice', {})).toMatchObject({ ok: true });
  });

  test('a dismissed notice is not raised again by reading the still-damaged value', async () => {
    const { b, send } = setup();
    await b.ports.vault.set(SETTINGS_KEY, { schemaVersion: 1, defaultLevel: 'turbo' });
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { settingsReset: true } });
    await send('c/dismissNotice', {});
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { settingsReset: false } });
    expect(await b.ports.vault.get(SETTINGS_KEY)).toEqual({ schemaVersion: 1, defaultLevel: 'turbo' });
  });

  test('c/dismissNotice only from the toolbar panel and the dashboard; vault failure is internal', async () => {
    const { b, send } = setup();
    const page = (p: string): object => ({ ...POPUP, url: `chrome-extension://${RUNTIME_ID}/${p}` });
    expect(await send('c/dismissNotice', {}, page('dashboard.html'))).toMatchObject({ ok: true });
    for (const p of ['onboarding.html', 'blocked.html', 'picker-panel.html']) {
      expect(await send('c/dismissNotice', {}, page(p))).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    }
    expect(await send('c/dismissNotice', {}, CONTENT)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await send('c/dismissNotice', { kind: 'x' })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    await b.ports.vault.set(NOTICE_KEY, { kind: 'settings-reset', reason: 'invalid', at: NOW });
    b.failNext('vault.set');
    expect(await send('c/dismissNotice', {})).toMatchObject({ ok: false, error: { code: 'internal' } });
    await b.ports.vault.set(NOTICE_KEY, 'not a notice');
    expect(await send('c/dismissNotice', {})).toMatchObject({ ok: true });
    expect(await b.ports.vault.get(NOTICE_KEY)).toBeUndefined();
  });

  test('D-31: lastRun is none before any run, failed after a failed run, ok after the next good one', async () => {
    const { b, send } = setup();
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { lastRun: 'none', ready: false } });
    b.failNext('catalog.read');
    await send('c/reconcile', {});
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { lastRun: 'failed', ready: true } });
    await send('c/reconcile', {});
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { lastRun: 'ok' } });
  });

  test('site commands answer with the host as stored (P2-14 snapshot), the parent value is not the host own', async () => {
    const { send } = setup();
    expect(await send('c/setSiteLevel', { hostname: HOST, level: 'thorough' })).toMatchObject({ data: { site: { ownLevel: 'thorough' } } });
    expect(await send('c/setSitePopupPolicy', { hostname: HOST, policy: 'allow' })).toMatchObject({ data: { site: { ownLevel: 'thorough', popupPolicy: 'allow' } } });
    expect(await send('q/tabState', { tabId: TAB })).toMatchObject({ data: { site: { ownLevel: 'thorough', popupPolicy: 'allow', pausedUntil: null } } });
  });
});
