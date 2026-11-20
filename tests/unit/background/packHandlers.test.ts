/**
 * P2-26: `c/setPack` with capacity checks. Enabling a pack that does not fit is refused with an honest,
 * structured error and nothing is stored; disabling always succeeds; the reconciler skips a stored pack
 * that no longer fits instead of failing the whole ruleset call.
 */
import { describe, expect, test } from 'vitest';
import type { RulesetId } from '../../../src/core/ids.js';
import { createWorker } from '../../../src/background/worker.js';
import { SETTINGS_KEY } from '../../../src/background/settingsStore.js';
import { createFakeBrowser, type FakeBrowser } from '../platform/fakes/browser.js';
import { NOW, settings, testCatalog } from '../core/reconcile/fixtures.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const page = (path: string): object => ({ id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/${path}`, origin: `chrome-extension://${RUNTIME_ID}` });
const POPUP = page('popup.html');
const CONTENT = { id: RUNTIME_ID, url: 'https://news.test/', origin: 'https://news.test', tab: { id: 7 }, frameId: 0 };
/** Every test ruleset holds 900 rules (ceiling 1,000 in the test catalog); the manifest enables the default safe ones. */
const rulesets = ['ubo', 'ubo-x', 'easyprivacy', 'cookies', 'cookies-x', 'popups'].map((id) => ({
  id: id as RulesetId,
  enabled: !id.endsWith('-x') && !id.startsWith('cookies'),
  regexCount: 1,
  ruleCount: 900,
}));
const DEFAULT_ON = ['easyprivacy', 'popups', 'ubo', 'ubo-x'];

let counter = 0;
const msg = (type: string, payload: unknown): unknown => ({ v: 1, type, id: `m${String((counter += 1))}`, payload });

/** `staticRules`: guaranteed + what other extensions left of the global pool. */
function setup(staticRules = 330_000): { b: FakeBrowser; send: (type: string, payload: unknown, sender?: object) => Promise<unknown> } {
  const b = createFakeBrowser({ rulesets, catalog: testCatalog(), now: () => NOW, limits: { staticRules } });
  const { handlers } = createWorker(b.ports, RUNTIME_ID);
  return { b, send: (type, payload, sender = POPUP) => handlers.message(msg(type, payload), sender) };
}

const stored = async (b: FakeBrowser): Promise<unknown> => b.ports.vault.get(SETTINGS_KEY);
const storedPacks = async (b: FakeBrowser): Promise<unknown> => ((await b.ports.vault.get(SETTINGS_KEY)) as { packs: unknown } | undefined)?.packs;

describe('c/setPack', () => {
  test('enable then disable: stored, reconciled, rulesets follow', async () => {
    const { b, send } = setup();
    expect(await send('c/setPack', { pack: 'trackers', enabled: false })).toEqual({ ok: true, data: { status: 'applied', skippedPacks: [], offerThorough: false } });
    expect(await storedPacks(b)).toEqual({ trackers: false });
    expect(await b.ports.dnr.getEnabledRulesets()).not.toContain('easyprivacy');
    expect(await send('c/setPack', { pack: 'trackers', enabled: true })).toMatchObject({ ok: true });
    expect(await storedPacks(b)).toEqual({ trackers: true });
    expect(await b.ports.dnr.getEnabledRulesets()).toEqual(DEFAULT_ON);
  });

  test('P2-27: the cookie pack follows cookieBanners (single source); Thorough is offered on enable', async () => {
    const { b, send } = setup();
    expect(await send('c/setPack', { pack: 'cookies', enabled: true })).toEqual({ ok: true, data: { status: 'applied', skippedPacks: [], offerThorough: true } });
    expect(await stored(b)).toMatchObject({ cookieBanners: 'hide', packs: {} });
    expect(await b.ports.dnr.getEnabledRulesets()).toEqual(['cookies', 'cookies-x', ...DEFAULT_ON].sort());

    expect(await send('c/setPack', { pack: 'cookies', enabled: false })).toMatchObject({ ok: true, data: { offerThorough: false } });
    expect(await stored(b)).toMatchObject({ cookieBanners: 'leave', packs: {} });
    expect(await b.ports.dnr.getEnabledRulesets()).toEqual(DEFAULT_ON);
  });

  test('no Thorough offer when the default is already Thorough or without all-sites access', async () => {
    const { b, send } = setup();
    await b.ports.vault.set(SETTINGS_KEY, settings({ defaultLevel: 'thorough' }));
    expect(await send('c/setPack', { pack: 'cookies', enabled: true })).toMatchObject({ data: { offerThorough: false } });
    const other = setup();
    other.b.setSiteAccess({ origins: [] });
    expect(await other.send('c/setPack', { pack: 'cookies', enabled: true })).toMatchObject({ data: { offerThorough: false } });
  });

  test('a pack whose rule ceilings do not fit the pool is refused honestly and not stored', async () => {
    // After the first reconcile the defaults hold 4 × 900 = 3,600 rules; 600 left, cookies needs up to 2 × 1,000.
    const { b, send } = setup(4_200);
    await send('c/reconcile', {});
    expect(await send('c/setPack', { pack: 'cookies', enabled: true })).toEqual({
      ok: false,
      error: { code: 'no-capacity', message: 'pack cookies does not fit: rule-pool needs 2000, 600 available', detail: { reason: 'rule-pool', needed: 2_000, available: 600 } },
    });
    expect(await stored(b)).toBeUndefined();
    expect(await b.ports.dnr.getEnabledRulesets()).toEqual(DEFAULT_ON);
  });

  test('disabling always succeeds, also when nothing would fit', async () => {
    const { b, send } = setup(2_700); // the pool is exactly full
    expect(await send('c/setPack', { pack: 'trackers', enabled: false })).toMatchObject({ ok: true });
    expect(await storedPacks(b)).toEqual({ trackers: false });
  });

  test('enabling a pack that is already on answers ok without a capacity refusal', async () => {
    const { send } = setup(4_200);
    await send('c/reconcile', {});
    expect(await send('c/setPack', { pack: 'ads', enabled: true })).toMatchObject({ ok: true });
  });

  test('unknown pack → not-found; the pop-up pack is not user-toggleable', async () => {
    const { b, send } = setup();
    expect(await send('c/setPack', { pack: 'reg-xx', enabled: true })).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(await send('c/setPack', { pack: 'popups', enabled: false })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await storedPacks(b)).toBeUndefined();
  });

  test('settings pages only: content scripts and blocked.html are refused, dashboard and onboarding accepted', async () => {
    const { send } = setup();
    const blocked = { ...page('blocked.html'), tab: { id: 3 }, frameId: 0 };
    expect(await send('c/setPack', { pack: 'cookies', enabled: true }, CONTENT)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await send('c/setPack', { pack: 'cookies', enabled: true }, blocked)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await send('c/setPack', { pack: 'cookies', enabled: true }, page('dashboard.html'))).toMatchObject({ ok: true });
    expect(await send('c/setPack', { pack: 'cookies', enabled: false }, page('onboarding.html'))).toMatchObject({ ok: true });
  });

  test('a failed vault read refuses without writing; a failed reconcile after the save is reported', async () => {
    const { b, send } = setup();
    b.failNext('vault.get');
    expect(await send('c/setPack', { pack: 'cookies', enabled: true })).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(await storedPacks(b)).toBeUndefined();
    b.failNext('dnr.updateEnabledRulesets');
    expect(await send('c/setPack', { pack: 'cookies', enabled: true })).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(await stored(b)).toMatchObject({ cookieBanners: 'hide' });
  });
});

describe('reconcile with the static rule pool', () => {
  test('a stored pack that no longer fits is skipped and reported; the defaults still apply', async () => {
    const { b, send } = setup(4_200);
    await b.ports.vault.set(SETTINGS_KEY, { ...settings(), cookieBanners: 'hide' });
    b.simulateUpdate();
    expect(await send('c/reconcile', {})).toEqual({
      ok: true,
      // 1,500 left after the manifest set; ads re-enables `ubo-x` (1,000), then cookies does not fit.
      data: { status: 'applied', skippedPacks: [{ pack: 'cookies', reason: 'rule-pool', needed: 2_000, available: 500 }] },
    });
    expect(await b.ports.dnr.getEnabledRulesets()).toEqual(DEFAULT_ON);
  });

  test('when the pool cannot be read the run goes on without the check', async () => {
    const { b, send } = setup();
    await b.ports.vault.set(SETTINGS_KEY, { ...settings(), cookieBanners: 'hide' });
    b.failNext('dnr.getAvailableStaticRuleCount');
    expect(await send('c/reconcile', {})).toMatchObject({ ok: true, data: { skippedPacks: [] } });
    expect(await b.ports.dnr.getEnabledRulesets()).toContain('cookies');
    expect(b.logs()).toContain('warn: static rule count unreadable; no capacity check this run');
  });
});

describe('c/setGpc (P2-31)', () => {
  test('stores settings.gpc and reconciles; settings pages only', async () => {
    const { b, send } = setup();
    expect(await send('c/setGpc', { enabled: true })).toMatchObject({ ok: true });
    expect(await stored(b)).toMatchObject({ gpc: true });
    expect(await send('c/setGpc', { enabled: true }, CONTENT)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await send('c/setGpc', { enabled: 'yes' })).toMatchObject({ ok: false, error: { code: 'invalid-payload' } });
    expect(await send('c/setGpc', { enabled: false }, page('dashboard.html'))).toMatchObject({ ok: true });
    expect(await stored(b)).toMatchObject({ gpc: false });
  });
});
