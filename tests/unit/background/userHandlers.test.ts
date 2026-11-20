/**
 * P2-20 / P2-21 / P2-55 handlers through the worker: picker start, save and remove of user filters with
 * the `uf:*` mirror and the `user-cosmetic` registration, the mirror audit, and "Proceed once" with its
 * session rule kept by later reconciles. Sender checks from both security reviews.
 */
import { describe, expect, test, vi } from 'vitest';
import { createWorker } from '../../../src/background/worker.js';
import { mintNonce } from '../../../src/background/picker.js';
import { USER_FILTER_AUDIT_ALARM } from '../../../src/background/userFilters.js';
import type { RulesetId } from '../../../src/core/ids.js';
import { PICKER_TABS_KEY, pickerSavedKey, pickerSessionKey } from '../../../src/core/picker/session.js';
import { USER_FILTERS_KEY } from '../../../src/core/userFilters/store.js';
import type { UserPorts } from '../../../src/platform/userPorts.js';
import { createFakeBrowser, type FakeBrowser } from '../platform/fakes/browser.js';
import { NOW, testCatalog } from '../core/reconcile/fixtures.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${ID}`;
const page = (path: string, extra: object = {}): object => ({ id: ID, url: `${ORIGIN}/${path}`, origin: ORIGIN, ...extra });
const POPUP = page('popup.html');
const PANEL = page('picker-panel.html', { tab: { id: 7 }, frameId: 3 });
const TAB = 7;
const HOST = 'www.news.example';
const rulesets = ['ubo', 'ubo-x', 'easyprivacy', 'cookies', 'cookies-x', 'popups'].map((id) => ({ id: id as RulesetId, enabled: !id.endsWith('-x'), regexCount: 1 }));
const LISTS = { 'popup-destinations.json': '["ads.example","pop.test"]', 'popup-strict-sites.json': '[]' };

let counter = 0;
const msg = (type: string, payload: unknown): unknown => ({ v: 1, type, id: `m${String((counter += 1))}`, payload });

interface Fake { local: Record<string, unknown>; injected: number[]; sent: unknown[]; active: number | null }

function setup() {
  const b = createFakeBrowser({ rulesets, catalog: testCatalog(), now: () => NOW, packageFiles: LISTS });
  const f: Fake = { local: {}, injected: [], sent: [], active: TAB };
  const user: UserPorts = {
    local: {
      getAll: () => Promise.resolve({ ...f.local }),
      set: (items) => { f.local = { ...f.local, ...items }; return Promise.resolve(); },
      remove: (keys) => { f.local = Object.fromEntries(Object.entries(f.local).filter(([k]) => !keys.includes(k))); return Promise.resolve(); },
    },
    injectPicker: (tabId) => { f.injected.push(tabId); return Promise.resolve(); },
    sendToTopFrame: (_tabId, message) => { f.sent.push(message); return Promise.resolve(undefined); },
    activeTabIds: () => Promise.resolve(f.active === null ? [] : [f.active]),
  };
  b.setTab(TAB, `https://${HOST}/article`);
  const worker = createWorker({ ...b.ports, user }, ID);
  const send = (type: string, payload: unknown, sender: object = POPUP): Promise<unknown> => worker.handlers.message(msg(type, payload), sender);
  return { b, f, worker, send };
}

/** Starts the picker from the toolbar panel and claims the session as the panel would. */
async function openSession(s: ReturnType<typeof setup>): Promise<string> {
  expect(await s.send('c/startPicker', { tabId: TAB, mode: 'hide' })).toEqual({ ok: true, data: null });
  const start = s.f.sent.at(-1) as { nonce: string };
  const key = pickerSessionKey(start.nonce);
  await s.b.ports.session.set(key, { ...(await s.b.ports.session.get(key) as object), claimed: true });
  return start.nonce;
}

const userScript = async (b: FakeBrowser) => (await b.ports.scripting.getRegisteredContentScripts()).find((r) => r.id === 'user-cosmetic');
const settle = async (s: ReturnType<typeof setup>): Promise<void> => { await s.worker.reconciler.request('test'); await new Promise((r) => { setTimeout(r, 0); }); };

describe('c/startPicker', () => {
  test('writes the session record first, injects picker.js into the top frame, then sends x/pickerStart', async () => {
    const s = setup();
    await openSession(s);
    const start = s.f.sent[0] as { type: string; nonce: string; mode: string };
    expect(start).toMatchObject({ type: 'x/pickerStart', mode: 'hide' });
    expect(start.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(s.f.injected).toEqual([TAB]);
    expect(await s.b.ports.session.get(PICKER_TABS_KEY)).toEqual({ [String(TAB)]: start.nonce });
  });

  test('the context menu passes the right-clicked element as a validated hint (P3-17); a bad one starts without', async () => {
    const s = setup();
    s.worker.handlers.contextMenu?.(TAB, { menuItemId: 'hide-element', frameId: 0, mediaType: 'image', srcUrl: 'https://cdn.example/p.png' });
    await vi.waitFor(() => { expect(s.f.sent).toHaveLength(1); });
    expect(s.f.sent[0]).toMatchObject({ type: 'x/pickerStart', mode: 'hide', hint: { kind: 'image', url: 'https://cdn.example/p.png' } });
    s.worker.handlers.contextMenu?.(TAB, { menuItemId: 'hide-element', frameId: 0, linkUrl: 'javascript:x' });
    await vi.waitFor(() => { expect(s.f.sent).toHaveLength(2); });
    expect(Object.keys(s.f.sent[1] as object).sort()).toEqual(['mode', 'nonce', 'type']);
  });

  test('only the toolbar panel, only for the active tab, only on web pages; a new start replaces the old session', async () => {
    const s = setup();
    expect(await s.send('c/startPicker', { tabId: TAB, mode: 'hide' }, PANEL)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await s.send('c/startPicker', { tabId: TAB, mode: 'hide' }, page('popup.html', { tab: { id: 2 }, frameId: 4 }))).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    s.f.active = 99;
    expect(await s.send('c/startPicker', { tabId: TAB, mode: 'hide' })).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    s.f.active = TAB;
    s.b.setTab(TAB, 'chrome://settings');
    expect(await s.send('c/startPicker', { tabId: TAB, mode: 'hide' })).toMatchObject({ ok: false, error: { code: 'not-found' } });
    s.b.setTab(TAB, `https://${HOST}/`);
    const first = await openSession(s);
    await openSession(s);
    expect(await s.b.ports.session.get(pickerSessionKey(first))).toBeUndefined();
  });

  test('context menu and keyboard shortcut start the picker in the event’s tab (no message, P2-21)', async () => {
    const s = setup();
    s.worker.handlers.contextMenu?.(TAB, { menuItemId: 'hide-element', frameId: 0 });
    await vi.waitFor(() => { expect(s.f.injected).toEqual([TAB]); });
    s.worker.handlers.command?.('other-command', TAB);
    s.worker.handlers.command?.('hide-element', TAB);
    await vi.waitFor(() => { expect(s.f.injected).toEqual([TAB, TAB]); });
    expect(s.f.sent).toHaveLength(2);
  });

  test('mintNonce: 128 bits, base64url', () => {
    expect(mintNonce((b) => { b.fill(255); })).toBe('_____________________w');
  });
});

describe('c/saveUserFilter and c/removeUserFilter (P2-20)', () => {
  test('a save from the panel stores under the host without www., mirrors it, registers user-cosmetic', async () => {
    const s = setup();
    const nonce = await openSession(s);
    expect(await s.send('c/saveUserFilter', { hostname: HOST, selector: '#ad', nonce }, PANEL)).toEqual({ ok: true, data: null });
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toEqual({ v: 1, hosts: { 'news.example': ['#ad'] } });
    expect(s.f.local).toEqual({ 'uf:news.example': { v: 1, s: ['#ad'] } });
    await settle(s);
    expect(await userScript(s.b)).toMatchObject({ world: 'ISOLATED', js: ['user-cosmetic.js'], matches: ['*://*.news.example/*'], allFrames: true });
    // Single use: the same nonce cannot save again.
    expect(await s.send('c/saveUserFilter', { hostname: HOST, selector: '.more', nonce }, PANEL)).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  test.each([
    ['a content script', { id: ID, url: `https://${HOST}/`, origin: `https://${HOST}`, tab: { id: TAB }, frameId: 0 }],
    ['the toolbar panel', POPUP],
    ['the panel as a top-level document', page('picker-panel.html', { tab: { id: TAB }, frameId: 0 })],
    ['the panel in another tab', page('picker-panel.html', { tab: { id: 8 }, frameId: 3 })],
  ])('refused from %s', async (_name, sender) => {
    const s = setup();
    const nonce = await openSession(s);
    const r = await s.send('c/saveUserFilter', { hostname: HOST, selector: '#ad', nonce }, sender);
    expect(r).toMatchObject({ ok: false });
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toBeUndefined();
  });

  test('refused: unclaimed session, other hostname, tab navigated elsewhere, unknown nonce', async () => {
    const s = setup();
    expect(await s.send('c/startPicker', { tabId: TAB, mode: 'hide' })).toMatchObject({ ok: true });
    const unclaimed = (s.f.sent[0] as { nonce: string }).nonce;
    expect(await s.send('c/saveUserFilter', { hostname: HOST, selector: '#ad', nonce: unclaimed }, PANEL)).toMatchObject({ ok: false, error: { code: 'not-found' } });
    const nonce = await openSession(s);
    expect(await s.send('c/saveUserFilter', { hostname: 'evil.example', selector: '#ad', nonce }, PANEL)).toMatchObject({ ok: false });
    s.b.setTab(TAB, 'https://elsewhere.example/');
    expect(await s.send('c/saveUserFilter', { hostname: HOST, selector: '#ad', nonce }, PANEL)).toMatchObject({ ok: false });
    expect(await s.send('c/saveUserFilter', { hostname: HOST, selector: '#ad', nonce: 'zzzzzzzzzzzzzzzzzzzzzz' }, PANEL)).toMatchObject({ ok: false });
  });

  test('Undo: the panel removes only what it just saved in this tab; the toolbar panel removes anything', async () => {
    const s = setup();
    const nonce = await openSession(s);
    await s.send('c/saveUserFilter', { hostname: HOST, selector: '#ad', nonce }, PANEL);
    expect(await s.send('c/removeUserFilter', { hostname: HOST, selector: '#other' }, PANEL)).toMatchObject({ ok: false });
    expect(await s.send('c/removeUserFilter', { hostname: HOST, selector: '#ad' }, page('picker-panel.html', { tab: { id: 8 }, frameId: 3 }))).toMatchObject({ ok: false });
    expect(await s.send('c/removeUserFilter', { hostname: HOST, selector: '#ad' }, PANEL)).toEqual({ ok: true, data: null });
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toEqual({ v: 1, hosts: {} });
    expect(s.f.local).toEqual({});
    expect(await s.b.ports.session.get(pickerSavedKey(TAB))).toBeUndefined();
    await settle(s);
    expect(await userScript(s.b)).toBeUndefined();
    await s.b.ports.vault.set(USER_FILTERS_KEY, { v: 1, hosts: { 'a.example': ['.x'] } });
    expect(await s.send('c/removeUserFilter', { hostname: 'a.example', selector: '.x' })).toEqual({ ok: true, data: null });
    expect(await s.send('c/removeUserFilter', { hostname: 'a.example', selector: '.x' }, { id: ID, url: 'https://a.example/', origin: 'https://a.example', tab: { id: 1 }, frameId: 0 })).toMatchObject({ ok: false });
  });

  test('the toolbar panel removes from its hidden-items view, as a popup or as a top-level tab (P3-17); framed, never', async () => {
    const s = setup();
    await s.b.ports.vault.set(USER_FILTERS_KEY, { v: 1, hosts: { 'a.example': ['.x', '.y', '.z'] } });
    expect(await s.send('c/removeUserFilter', { hostname: 'a.example', selector: '.x' }, POPUP)).toEqual({ ok: true, data: null });
    expect(await s.send('c/removeUserFilter', { hostname: 'a.example', selector: '.y' }, page('popup.html?tabId=7', { tab: { id: 9 }, frameId: 0 }))).toEqual({ ok: true, data: null });
    expect(await s.send('c/removeUserFilter', { hostname: 'a.example', selector: '.z' }, page('popup.html', { tab: { id: 9 }, frameId: 2 }))).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toEqual({ v: 1, hosts: { 'a.example': ['.z'] } });
  });

  test('an unreadable vault value is never overwritten: saves refused, the mirror left as it is (review LOW-6)', async () => {
    const s = setup();
    await s.b.ports.vault.set(USER_FILTERS_KEY, 'corrupt');
    s.f.local = { 'uf:news.example': { v: 1, s: ['#ad'] } };
    const nonce = await openSession(s);
    expect(await s.send('c/saveUserFilter', { hostname: HOST, selector: '#x', nonce }, PANEL)).toMatchObject({ ok: false, error: { code: 'internal' } });
    s.worker.handlers.alarm(USER_FILTER_AUDIT_ALARM);
    await new Promise((r) => { setTimeout(r, 0); });
    expect(await s.b.ports.vault.get(USER_FILTERS_KEY)).toBe('corrupt');
    expect(s.f.local).toEqual({ 'uf:news.example': { v: 1, s: ['#ad'] } });
  });

  test('tampered mirror: the audit (every reconcile, daily alarm) rewrites it from the vault', async () => {
    const s = setup();
    await s.b.ports.vault.set(USER_FILTERS_KEY, { v: 1, hosts: { 'news.example': ['#ad'] } });
    s.f.local = { 'uf:news.example': { v: 1, s: ['body'] }, 'uf:evil.example': { v: 1, s: ['html'] }, unrelated: 1 };
    s.worker.handlers.alarm(USER_FILTER_AUDIT_ALARM);
    await new Promise((r) => { setTimeout(r, 0); });
    expect(s.f.local).toEqual({ 'uf:news.example': { v: 1, s: ['#ad'] }, unrelated: 1 });
    expect(s.b.alarms()[USER_FILTER_AUDIT_ALARM]).toBeGreaterThan(NOW);
    // Without filters the alarm goes: no daily wake-up for a profile that never hid anything.
    await s.b.ports.vault.set(USER_FILTERS_KEY, { v: 1, hosts: {} });
    s.worker.handlers.alarm(USER_FILTER_AUDIT_ALARM);
    await new Promise((r) => { setTimeout(r, 0); });
    expect(s.b.alarms()[USER_FILTER_AUDIT_ALARM]).toBeUndefined();
  });
});

describe('c/proceedOnce (P2-55)', () => {
  const blocked = (tabId: number, fragment: string, frameId = 0): object => page(`blocked.html#${fragment}`, { tab: { id: tabId }, frameId });

  test('adds one session allow rule for the host in that tab; a reconcile keeps it; a repeat replaces it', async () => {
    const s = setup();
    expect(await s.send('c/proceedOnce', { hostname: 'ads.example' }, blocked(TAB, 'https://ads.example/x'))).toEqual({ ok: true, data: null });
    const rules = await s.b.ports.dnr.getSessionRules();
    expect(rules).toEqual([{ id: 1, priority: 3, action: { type: 'allow' }, condition: { requestDomains: ['ads.example'], tabIds: [TAB], resourceTypes: ['main_frame'] } }]);
    await s.worker.reconciler.request('test');
    expect(await s.b.ports.dnr.getSessionRules()).toEqual(rules);
    await s.send('c/proceedOnce', { hostname: 'ads.example' }, blocked(TAB, 'https://ads.example/y'));
    expect(await s.b.ports.dnr.getSessionRules()).toHaveLength(1);
  });

  test('a rule of a tab that no longer exists is pruned by the next call and by the next reconcile', async () => {
    const dead = { id: 4, priority: 3, action: { type: 'allow' as const }, condition: { requestDomains: ['pop.test'], tabIds: [42], resourceTypes: ['main_frame' as const] } };
    const s = setup();
    await s.b.ports.dnr.updateSessionRules({ removeRuleIds: [], addRules: [dead] });
    await s.worker.reconciler.request('test');
    expect(await s.b.ports.dnr.getSessionRules()).toEqual([]);
    await s.b.ports.dnr.updateSessionRules({ removeRuleIds: [], addRules: [dead] });
    await s.send('c/proceedOnce', { hostname: 'ads.example' }, blocked(TAB, 'https://ads.example/'));
    expect((await s.b.ports.dnr.getSessionRules()).map((r) => r.condition.tabIds)).toEqual([[TAB]]);
  });

  test.each([
    ['payload host differs from the page’s fragment', 'ads.example', blocked(TAB, 'https://pop.test/')],
    ['not a listed destination', 'news.example', blocked(TAB, 'https://news.example/')],
    ['framed copy', 'ads.example', blocked(TAB, 'https://ads.example/', 2)],
    ['another page of ours', 'ads.example', page('popup.html#https://ads.example/', { tab: { id: TAB }, frameId: 0 })],
    ['hostile fragment', 'ads.example', blocked(TAB, 'javascript:alert(1)')],
  ])('refused: %s', async (_name, hostname, sender) => {
    const s = setup();
    expect(await s.send('c/proceedOnce', { hostname }, sender)).toMatchObject({ ok: false });
    expect(await s.b.ports.dnr.getSessionRules()).toEqual([]);
  });

  test('refused without all-sites access (the redirect is not live)', async () => {
    const s = setup();
    s.b.setSiteAccess({ origins: [] });
    expect(await s.send('c/proceedOnce', { hostname: 'ads.example' }, blocked(TAB, 'https://ads.example/'))).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  test('a reconcile drops a foreign or malformed rule in the session range', async () => {
    const s = setup();
    await s.b.ports.dnr.updateSessionRules({ removeRuleIds: [], addRules: [{ id: 5, priority: 3, action: { type: 'allow' }, condition: { requestDomains: ['x.example'], resourceTypes: ['main_frame'] } }] });
    await s.worker.reconciler.request('test');
    expect(await s.b.ports.dnr.getSessionRules()).toEqual([]);
  });
});
