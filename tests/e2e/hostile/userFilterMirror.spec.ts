/**
 * J15 · the `uf:` user-filter mirror (P2-20). `storage.local` is writable from any of our contexts, content
 * scripts included, so `user-cosmetic` treats the mirror as hostile input: whatever is written there, only
 * `selector{display:none!important}` with a sanitised selector is ever applied, nothing is fetched, a value of
 * the wrong shape applies nothing, and the next reconcile re-derives the mirror from the vault. The tampering is
 * written from the worker here (the strongest writer a page could ever borrow).
 */
import { test, expect, type Page } from '@playwright/test';
import { expectNoExtensionNetwork, HOST, openHostile, POLL, SESSION_TIMEOUT_MS, startHostile, stopHostile, type Hostile } from './harness.js';

const KEY = `uf:${HOST}`;
const EVIL = 'evil.hostile-dest.example';
const RECONCILE = { timeout: 60_000 };
/** Past the per-host cap (100): the extra selectors are dropped, not applied. */
const OVER_CAP = 150;

let h: Hostile;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(SESSION_TIMEOUT_MS);
  h = await startHostile();
  await saveInVault({ v: 1, hosts: { [HOST]: ['#ad'] } });
  await expect.poll(() => h.worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, KEY), RECONCILE).toEqual({ v: 1, s: ['#ad'] });
  await expect.poll(() => h.worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).some((s) => s.id === 'user-cosmetic')), RECONCILE).toBe(true);
});
test.afterAll(async () => { await stopHostile(); });

/** The user's filters as the worker stores them (vault key `userFilters`), then a reconcile from an extension page. */
async function saveInVault(value: object): Promise<void> {
  const page = await h.context.newPage();
  await page.goto(`chrome-extension://${h.session.id}/fx.html`);
  await page.evaluate(async (v) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('vault', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => { resolve(req.result); };
      req.onerror = () => { reject(req.error ?? new Error('open failed')); };
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, 'userFilters');
      tx.oncomplete = () => { resolve(); };
      tx.onerror = () => { reject(tx.error ?? new Error('write failed')); };
    });
    db.close();
    await chrome.runtime.sendMessage({ v: 1, type: 'c/reconcile', id: 'j15', payload: {} });
  }, value);
  await page.close();
}

const tamper = (values: Record<string, unknown>): Promise<void> => h.worker.evaluate((v) => chrome.storage.local.set(v), values);
const display = (tab: Page, sel: string): Promise<string> => tab.locator(sel).evaluate((e) => getComputedStyle(e).display);

test('control: the saved filter hides #ad at document_start', async () => {
  const tab = await openHostile(h, 'mirror');
  await expect.poll(() => display(tab, '#ad'), POLL).toBe('none');
  expect(await display(tab, '#keep')).not.toBe('none');
  await tab.close();
});

test('injection attempts in the mirror apply nothing but display:none, fetch nothing, and the reconcile repairs it', async () => {
  const injected = [
    'body{background:rgb(255,0,0)}', '#keep{}', `@import url(https://${EVIL}/a.css)`, `#other{background:url(https://${EVIL}/b.png)}`,
    `#other,html{background-image:image-set("https://${EVIL}/c.png" 1x)}`, '#other\\', '.a\\7b body', '</style><script>alert(1)</script>', '/* x */ body',
    '#other '.repeat(2_000), 42, null, { toString: '#other' }, ['#other'],
  ];
  await tamper({
    [KEY]: { v: 1, s: [...injected, '#ad'] },
    [`uf:${EVIL}`]: { v: 1, s: ['html'] },
    'uf:hostile-dest.example': { v: 2, s: ['html'] },
  });
  h.server.clearLog();
  const tab = await openHostile(h, 'mirror');
  await expect.poll(() => display(tab, '#ad'), POLL).toBe('none');
  expect(await display(tab, '#keep')).not.toBe('none');
  expect(await display(tab, '#other')).not.toBe('none');
  expect(await tab.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  const rules = await tab.evaluate(() => document.adoptedStyleSheets.flatMap((s) => [...s.cssRules].map((r) => r.cssText)));
  // Hiding rules, plus the list's own sanitised `:style()` rule for this host (cosmetic-specific).
  for (const rule of rules) expect(rule).toMatch(/^(?:.+ \{ display: none !important; \}|\.sticky \{ position: static !important; \})$/);
  await tab.waitForTimeout(500);
  expect(h.server.log().filter((r) => r.host === EVIL)).toEqual([]);
  await tab.close();
  // A reconcile re-derives every `uf:` key from the vault.
  await saveInVault({ v: 1, hosts: { [HOST]: ['#ad'] } });
  await expect.poll(() => h.worker.evaluate(async () => Object.fromEntries(Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith('uf:')))), RECONCILE)
    .toEqual({ [KEY]: { v: 1, s: ['#ad'] } });
});

test('a tampered mirror can hide on its own host only, at most the per-host cap, and a wrong-shaped value hides nothing', async () => {
  await tamper({ [KEY]: { v: 1, s: [...Array.from({ length: OVER_CAP }, (_, i) => `.n${String(i).padStart(3, '0')}`), '#keep'] } });
  const tab = await openHostile(h, 'mirror');
  // The mirror's own rules (the list's cosmetic rules for this host sit in another sheet).
  const count = await tab.evaluate(() => document.adoptedStyleSheets.flatMap((s) => [...s.cssRules]).filter((r) => /^(?:\.n\d{3}|#keep) /.test(r.cssText)).length);
  expect(count).toBe(100);
  await tab.close();
  for (const value of [['#keep'], '#keep', { v: '1', s: ['#keep'] }, { v: 1, s: '#keep' }, { v: 1, s: { 0: '#keep', length: 1 } }]) {
    await tamper({ [KEY]: value });
    const page = await openHostile(h, 'mirror');
    await page.waitForTimeout(300);
    expect(await display(page, '#keep'), JSON.stringify(value)).not.toBe('none');
    expect(await display(page, '#ad'), JSON.stringify(value)).not.toBe('none');
    await page.close();
  }
  await saveInVault({ v: 1, hosts: { [HOST]: ['#ad'] } });
  await expect.poll(() => h.worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, KEY), RECONCILE).toEqual({ v: 1, s: ['#ad'] });
});

test('J16 row: no extension-initiated request during the mirror probes', () => {
  expectNoExtensionNetwork(h);
});
