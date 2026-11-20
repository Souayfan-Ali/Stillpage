/**
 * P2-54: `c/setPopupMode` and `c/setSitePopupPolicy` through the worker. Validated, refused from content
 * scripts and from pages that are not settings pages, stored, reconciled; the worker reads the packaged
 * pop-up lists and installs the `allow` rules. Until `blocked.html` (P2-55) and the guard scripts
 * (P2-57 / P2-58) ship, no redirect rule and no guard registration is installed.
 */
import { describe, expect, test } from 'vitest';
import { createWorker } from '../../../src/background/worker.js';
import { SETTINGS_KEY } from '../../../src/background/settingsStore.js';
import { dynamicRealmOf } from '../../../src/core/limits.js';
import type { RulesetId } from '../../../src/core/ids.js';
import { createFakeBrowser, type FakeBrowser } from '../platform/fakes/browser.js';
import { NOW, settings, testCatalog } from '../core/reconcile/fixtures.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const page = (path: string): object => ({ id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/${path}`, origin: `chrome-extension://${RUNTIME_ID}` });
const POPUP = page('popup.html');
const CONTENT = { id: RUNTIME_ID, url: 'https://news.test/', origin: 'https://news.test', tab: { id: 7 }, frameId: 0 };
const BLOCKED = { ...page('blocked.html'), tab: { id: 3 }, frameId: 0 };
const rulesets = ['ubo', 'ubo-x', 'easyprivacy', 'cookies', 'cookies-x', 'popups'].map((id) => ({ id: id as RulesetId, enabled: !id.endsWith('-x'), regexCount: 1 }));
const LISTS = { 'popup-destinations.json': '["ads.example","pop.test"]', 'popup-strict-sites.json': '["list.example"]' };

let counter = 0;
const msg = (type: string, payload: unknown): unknown => ({ v: 1, type, id: `m${String((counter += 1))}`, payload });

function setup(packageFiles: Readonly<Record<string, string>> = LISTS): { b: FakeBrowser; send: (type: string, payload: unknown, sender?: object) => Promise<unknown> } {
  const b = createFakeBrowser({ rulesets, catalog: testCatalog(), now: () => NOW, packageFiles });
  const { handlers } = createWorker(b.ports, RUNTIME_ID);
  return { b, send: (type, payload, sender = POPUP) => handlers.message(msg(type, payload), sender) };
}

const storedPopups = async (b: FakeBrowser): Promise<unknown> => ((await b.ports.vault.get(SETTINGS_KEY)) as { popups: unknown } | undefined)?.popups;
const popupRealm = async (b: FakeBrowser) => (await b.ports.dnr.getDynamicRules()).filter((r) => dynamicRealmOf(r.id) === 'popupDestinations');

describe('c/setPopupMode', () => {
  test('stores the mode and reconciles', async () => {
    const { b, send } = setup();
    expect(await send('c/setPopupMode', { mode: 'smart' })).toMatchObject({ ok: true });
    expect(await storedPopups(b)).toEqual({ mode: 'smart', sites: {}, notice: true });
  });

  test('validated, and refused from content scripts and blocked.html', async () => {
    const { b, send } = setup();
    expect(await send('c/setPopupMode', { mode: 'always' })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await send('c/setPopupMode', { mode: 'smart' }, CONTENT)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await send('c/setPopupMode', { mode: 'smart' }, BLOCKED)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await storedPopups(b)).toBeUndefined();
  });
});

describe('c/setSitePopupPolicy', () => {
  test('Allow adds the opener allow rule; inherit removes it again', async () => {
    const { b, send } = setup();
    expect(await send('c/setSitePopupPolicy', { hostname: 'shop.example', policy: 'allow' })).toMatchObject({ ok: true });
    expect(await storedPopups(b)).toMatchObject({ sites: { 'shop.example': 'allow' } });
    const allows = async () => (await popupRealm(b)).filter((r) => r.action.type === 'allow').map((r) => r.condition.initiatorDomains);
    expect(await allows()).toEqual([['shop.example']]);

    expect(await send('c/setSitePopupPolicy', { hostname: 'shop.example', policy: 'inherit' })).toMatchObject({ ok: true });
    expect(await allows()).toEqual([]);
  });

  test('validated, refused from content scripts and blocked.html; a site beyond the cap is refused', async () => {
    const { b, send } = setup();
    expect(await send('c/setSitePopupPolicy', { hostname: 'Bad Host', policy: 'allow' })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await send('c/setSitePopupPolicy', { hostname: 'a.com', policy: 'smart' })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await send('c/setSitePopupPolicy', { hostname: 'a.com', policy: 'allow' }, CONTENT)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await send('c/setSitePopupPolicy', { hostname: 'a.com', policy: 'allow' }, BLOCKED)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    const sites = Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`s${String(i)}.com`, 'allow']));
    await b.ports.vault.set(SETTINGS_KEY, { ...settings(), popups: { mode: 'off', sites, notice: true } });
    expect(await send('c/setSitePopupPolicy', { hostname: 'a.com', policy: 'strict' })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
  });
});

describe('pop-up part of every reconcile', () => {
  test('Off sites get the opener allow rule; listed hosts redirect to blocked.html (P2-55); guard scripts registered top-level only (P2-58)', async () => {
    const { b, send } = setup();
    await b.ports.vault.set(SETTINGS_KEY, { ...settings({ siteLevels: { 'off.example': 'off' } }), popups: { mode: 'strict', sites: {}, notice: true } });
    expect(await send('c/reconcile', {})).toMatchObject({ ok: true });
    const realm = await popupRealm(b);
    expect(realm.filter((r) => r.action.type === 'allow')).toHaveLength(1);
    const redirects = realm.filter((r) => r.action.type === 'redirect');
    expect(redirects.length).toBeGreaterThan(0);
    expect(redirects.every((r) => r.action.redirect?.regexSubstitution?.endsWith('/blocked.html#\\0') === true)).toBe(true);
    // Since P2-58 the guard ships: Strict mode registers the sentinel, the shim and the Strict flag.
    const scripts = await b.ports.scripting.getRegisteredContentScripts();
    expect(scripts.filter((s) => s.id.startsWith('popup-')).map((s) => [s.id, s.world, s.allFrames])).toEqual([
      ['popup-sentinel', 'ISOLATED', false], ['popup-shim', 'MAIN', false], ['popup-strict', 'ISOLATED', false]]);
  });

  test('unreadable or invalid pop-up lists are logged; the run goes on', async () => {
    const { b, send } = setup({ 'popup-destinations.json': '{"x":1}' });
    expect(await send('c/reconcile', {})).toMatchObject({ ok: true });
    expect(b.logs()).toEqual(expect.arrayContaining(['error: pop-up list popup-destinations.json unusable', 'error: pop-up list popup-strict-sites.json unusable']));
  });
});

describe('c/setPopupNotice (P2-60b)', () => {
  test('stores the notice choice from a settings page; refused from a content script and from blocked.html', async () => {
    const { b, send } = setupNotice();
    expect(await send('c/setPopupNotice', { enabled: false })).toMatchObject({ ok: true });
    expect(((await b.ports.vault.get('settings')) as { popups: { notice: boolean } }).popups.notice).toBe(false);
    expect(await send('c/setPopupNotice', { enabled: 'no' })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await send('c/setPopupNotice', { enabled: true }, { id: NOTICE_RUNTIME, url: 'https://news.test/', tab: { id: 1 }, frameId: 0 })).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await send('c/setPopupNotice', { enabled: true }, { id: NOTICE_RUNTIME, url: `chrome-extension://${NOTICE_RUNTIME}/blocked.html`, tab: { id: 1 }, frameId: 0 })).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
  });
});

const NOTICE_RUNTIME = 'abcdefghijklmnopabcdefghijklmnop';

function setupNotice() {
  const b = createFakeBrowser({ rulesets: [], now: () => 1_800_000_000_000 });
  const { handlers } = createWorker(b.ports, NOTICE_RUNTIME);
  const page = { id: NOTICE_RUNTIME, url: `chrome-extension://${NOTICE_RUNTIME}/dashboard.html`, origin: `chrome-extension://${NOTICE_RUNTIME}` };
  let n = 0;
  return { b, send: (type: string, payload: unknown, sender: object = page) => handlers.message({ v: 1, type, id: `n${String((n += 1))}`, payload }, sender) };
}
