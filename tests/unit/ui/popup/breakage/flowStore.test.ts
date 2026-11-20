import { describe, expect, test, vi } from 'vitest';
import { createWorker } from '../../../../../src/background/worker.js';
import { SETTINGS_KEY } from '../../../../../src/background/settingsStore.js';
import { FLOW_TTL_MS, flowKey } from '../../../../../src/core/breakage/storage.js';
import type { Hostname, RulesetId } from '../../../../../src/core/ids.js';
import { createClient } from '../../../../../src/features/popup/client.js';
import { createFlowStore, type FlowStore } from '../../../../../src/features/popup/breakage/flowStore.js';
import { createFakeBrowser, type FakeBrowser } from '../../../platform/fakes/browser.js';
import { NOW, testCatalog } from '../../../core/reconcile/fixtures.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const POPUP = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/popup.html?tabId=7`, origin: `chrome-extension://${RUNTIME_ID}` };
const TAB = 7;
const HOST = 'news.example.com' as Hostname;

function memorySession() {
  let items: Record<string, unknown> = {};
  return {
    get: (k: string) => Promise.resolve(structuredClone(items[k])),
    set: (k: string, v: unknown) => {
      items = { ...items, [k]: structuredClone(v) };
      return Promise.resolve();
    },
    remove: (k: string) => {
      items = Object.fromEntries(Object.entries(items).filter(([key]) => key !== k));
      return Promise.resolve();
    },
    items: () => items,
  };
}

interface Rig {
  readonly b: FakeBrowser;
  readonly flow: FlowStore;
  readonly session: ReturnType<typeof memorySession>;
  readonly reloadTab: ReturnType<typeof vi.fn<(tabId: number) => Promise<void>>>;
  readonly tick: (ms: number) => void;
  readonly reopen: () => Promise<FlowStore>;
}

async function rig(popupLog?: () => Promise<{ hosts: string[]; blocked: number; codes: ('G11' | 'TU')[] } | null>): Promise<Rig> {
  let clock = NOW;
  const b = createFakeBrowser({ rulesets: [{ id: 'ubo' as RulesetId, enabled: true, regexCount: 0 }], catalog: testCatalog(), now: () => clock });
  b.setTab(TAB, `https://${HOST}/story?id=1`);
  const { handlers } = createWorker(b.ports, RUNTIME_ID);
  const client = createClient({ send: (envelope) => handlers.message(envelope, POPUP) });
  const session = memorySession();
  const reloadTab = vi.fn<(tabId: number) => Promise<void>>(() => Promise.resolve());
  const make = async (): Promise<FlowStore> => {
    const store = createFlowStore({ client, session, reloadTab, now: () => clock, tabId: TAB, host: HOST, ...(popupLog === undefined ? {} : { popupLog }) });
    await store.load();
    return store;
  };
  await handlers.message({ v: 1, type: 'c/reconcile', id: 'r', payload: {} }, POPUP);
  return { b, flow: await make(), session, reloadTab, tick: (ms) => (clock += ms), reopen: make };
}

const stored = async (b: FakeBrowser): Promise<{ siteLevels: object; pauses: object }> => (await b.ports.vault.get(SETTINGS_KEY)) as { siteLevels: object; pauses: object };

describe('breakage flow in the panel (P2-14)', () => {
  test('page broken: Light is tried and the tab reloaded; the state is stored before the reload', async () => {
    const { b, flow, session, reloadTab } = await rig();
    expect(flow.view.value).toEqual({ kind: 'choose' });
    await flow.start('broken');
    expect(flow.view.value).toMatchObject({ kind: 'active', state: { complaint: 'broken', step: 1, phase: 'offer' } });
    reloadTab.mockImplementationOnce(() => {
      expect(session.items()[flowKey(TAB)]).toMatchObject({ phase: 'await', trial: { remedy: 'light' } });
      return Promise.resolve();
    });
    await flow.tryIt('light');
    expect(reloadTab).toHaveBeenCalledWith(TAB);
    expect((await stored(b)).siteLevels).toEqual({ [HOST]: 'light' });
  });

  test('state survives the panel closing: a reopened panel is at "After the reload"', async () => {
    const { flow, reopen } = await rig();
    await flow.start('broken');
    await flow.tryIt('light');
    expect((await reopen()).view.value).toMatchObject({ kind: 'active', state: { phase: 'await', trial: { remedy: 'light' } } });
  });

  test('still broken undoes Light and offers Off from the original level; Fixed keeps Off and ends', async () => {
    const { b, flow, session } = await rig();
    await flow.start('broken');
    await flow.tryIt('light');
    await flow.stillBroken();
    expect((await stored(b)).siteLevels).toEqual({});
    expect(flow.view.value).toMatchObject({ kind: 'active', state: { step: 2, phase: 'offer', outcomes: [{ remedy: 'light', result: 'still-broken', revert: 'reverted' }] } });
    await flow.tryIt('off');
    await flow.fixed();
    expect(flow.view.value).toEqual({ kind: 'fixed', remedy: 'off' });
    expect((await stored(b)).siteLevels).toEqual({ [HOST]: 'off' });
    expect(session.items()).toEqual({});
  });

  test('anti-adblock: a pause trial records the until the worker stored, so "Still broken" can undo it', async () => {
    const { b, flow, tick } = await rig();
    await flow.start('antiAdblock');
    await flow.tryIt('thorough');
    await flow.stillBroken();
    tick(5);
    await flow.tryIt('pause');
    const until = NOW + 5 + 30 * 60_000;
    expect((await stored(b)).pauses).toEqual({ [HOST]: { until } });
    expect(flow.view.value).toMatchObject({ kind: 'active', state: { trial: { applied: { kind: 'pause', until } } } });
    tick(1_000);
    await flow.stillBroken();
    expect((await stored(b)).pauses).toEqual({});
    expect(flow.view.value).toMatchObject({ kind: 'active', state: { phase: 'report' } });
  });

  test('a setting changed by the user since the trial is left alone and the panel says so', async () => {
    const { b, flow } = await rig();
    await flow.start('broken');
    await flow.tryIt('light');
    await b.ports.vault.set(SETTINGS_KEY, { ...(await stored(b)), siteLevels: { [HOST]: 'thorough' } });
    await flow.stillBroken();
    expect((await stored(b)).siteLevels).toEqual({ [HOST]: 'thorough' });
    expect(flow.status.value).toBe('The setting was changed since, so it was left as it is.');
  });

  test('cancel undoes a pending trial; reload and picker rungs have no settings change', async () => {
    const { b, flow, reloadTab } = await rig();
    await flow.start('adThrough');
    await flow.tryIt('reload');
    expect(reloadTab).toHaveBeenCalledTimes(1);
    await flow.stillBroken();
    await flow.tryIt('picker');
    // c/startPicker exists since P2-21; in this rig the tab is not an active tab of a window, so it is refused.
    expect(flow.status.value).toBe('Could not start hiding elements on this page.');
    await flow.stillBroken();
    await flow.tryIt('thorough');
    expect((await stored(b)).siteLevels).toEqual({ [HOST]: 'thorough' });
    await flow.cancel();
    expect((await stored(b)).siteLevels).toEqual({});
    expect(flow.view.value).toEqual({ kind: 'choose' });
  });

  test('an unanswered trial past the TTL is offered as keep or undo', async () => {
    const r = await rig();
    await r.flow.start('broken');
    await r.flow.tryIt('light');
    r.tick(FLOW_TTL_MS + 1);
    const kept = await r.reopen();
    expect(kept.view.value).toMatchObject({ kind: 'orphan', trial: { remedy: 'light' } });
    await kept.undoOrphan();
    expect((await stored(r.b)).siteLevels).toEqual({});
    expect(kept.view.value).toEqual({ kind: 'choose' });
    expect(r.session.items()).toEqual({});

    await kept.start('broken');
    await kept.tryIt('light');
    r.tick(FLOW_TTL_MS + 1);
    const again = await r.reopen();
    await again.keepOrphan();
    expect((await stored(r.b)).siteLevels).toEqual({ [HOST]: 'light' });
  });

  test('report keeps a pending trial; a flow of another host on the tab is not shown', async () => {
    const r = await rig();
    await r.flow.start('broken');
    await r.flow.report();
    expect(r.flow.view.value).toMatchObject({ kind: 'active', state: { phase: 'report' } });
    r.b.setTab(TAB, 'https://other.example.org/');
    const other = createFlowStore({ client: createClient({ send: () => Promise.resolve(null) }), session: r.session, reloadTab: r.reloadTab, now: () => NOW, tabId: TAB, host: 'other.example.org' as Hostname });
    await other.load();
    expect(other.view.value).toEqual({ kind: 'choose' });
    expect(r.session.items()[flowKey(TAB)]).toBeDefined();
  });

  test('a session read failure keeps the stored flow and says so (P2-44)', async () => {
    // Arrange: a trial in progress, then a reopen whose session read fails
    const r = await rig();
    await r.flow.start('broken');
    vi.spyOn(r.session, 'get').mockRejectedValueOnce(new Error('session gone'));
    const remove = vi.spyOn(r.session, 'remove');

    // Act
    const reopened = await r.reopen();

    // Assert
    expect(remove).not.toHaveBeenCalled();
    expect(r.session.items()[flowKey(TAB)]).toBeDefined();
    expect(reopened.view.value).toEqual({ kind: 'choose' });
    expect(reopened.status.value).not.toBe('');
  });

  test('a session write failure stops before any effect and says so', async () => {
    const r = await rig();
    await r.flow.start('broken');
    vi.spyOn(r.session, 'set').mockRejectedValueOnce(new Error('quota'));
    await r.flow.tryIt('light');
    expect(r.reloadTab).not.toHaveBeenCalled();
    expect(await r.b.ports.vault.get(SETTINGS_KEY)).toBeUndefined();
    expect(r.flow.status.value).toBe('Could not save this step. Try again.');
  });

  test('an expired trial of another host on the same tab is not offered (security review MEDIUM)', async () => {
    const r = await rig();
    await r.flow.start('broken');
    await r.flow.tryIt('light');
    r.tick(FLOW_TTL_MS + 1);
    r.b.setTab(TAB, 'https://other.example.org/');
    const other = createFlowStore({ client: createClient({ send: () => Promise.resolve(null) }), session: r.session, reloadTab: r.reloadTab, now: () => NOW + FLOW_TTL_MS + 1, tabId: TAB, host: 'other.example.org' as Hostname });
    await other.load();
    expect(other.view.value).toEqual({ kind: 'choose' });
    expect((await stored(r.b)).siteLevels).toEqual({ [HOST]: 'light' });
  });

  test('a refused change does not advance: the offer stays, stored as it was (review MEDIUM)', async () => {
    const r = await rig();
    await r.flow.start('broken');
    r.b.failNext('vault.set');
    await r.flow.tryIt('light');
    expect(r.flow.view.value).toMatchObject({ kind: 'active', state: { phase: 'offer', trial: null } });
    expect(r.session.items()[flowKey(TAB)]).toMatchObject({ phase: 'offer', trial: null });
    expect(r.flow.status.value).toBe('Could not apply the change. Try again.');
  });

  test('cancel without a readable tab keeps the flow and its trial (review MEDIUM)', async () => {
    const r = await rig();
    await r.flow.start('broken');
    await r.flow.tryIt('light');
    r.b.setTab(TAB, 'https://elsewhere.example.net/');
    await r.flow.cancel();
    expect(r.flow.view.value).toMatchObject({ kind: 'active', state: { trial: { remedy: 'light' } } });
    expect((await stored(r.b)).siteLevels).toEqual({ [HOST]: 'light' });
  });

  test('P2-62: a pop-up blocked on the page puts "Allow pop-ups on this site" first for page broken; trying it allows and reloads', async () => {
    const r = await rig(() => Promise.resolve({ hosts: ['ad.example'], blocked: 2, codes: ['G11'] }));
    await r.flow.start('broken');
    expect(r.flow.view.value).toMatchObject({ kind: 'active', state: { step: 0, phase: 'offer' } });
    await r.flow.tryIt('allowPopups');
    const stored = (await r.b.ports.vault.get(SETTINGS_KEY)) as { popups: { sites: object } };
    expect(stored.popups.sites).toEqual({ [HOST]: 'allow' });
    await r.flow.stillBroken();
    expect(((await r.b.ports.vault.get(SETTINGS_KEY)) as { popups: { sites: object } }).popups.sites).toEqual({});
    expect(r.flow.view.value).toMatchObject({ kind: 'active', state: { step: 1 } });
  });

  test('P2-62: no sentinel or nothing blocked: page broken starts at Light as before', async () => {
    for (const log of [() => Promise.resolve(null), () => Promise.resolve({ hosts: [], blocked: 0, codes: [] as ('G11' | 'TU')[] })]) {
      const r = await rig(log);
      await r.flow.start('broken');
      expect(r.flow.view.value).toMatchObject({ kind: 'active', state: { step: 1 } });
    }
  });

  test('P2-62: the fourth ladder (an ad opened a new tab): reload, then Strict offered now that the guard ships', async () => {
    const { flow, reloadTab } = await rig();
    await flow.start('popupOpened');
    await flow.tryIt('reload');
    expect(reloadTab).toHaveBeenCalledTimes(1);
    await flow.stillBroken();
    expect(flow.view.value).toMatchObject({ kind: 'active', state: { phase: 'offer', outcomes: [{ remedy: 'reload', result: 'still-broken' }] } });
  });
});
