import { describe, expect, test, vi } from 'vitest';
import type { Client, ClientResult } from '../../../../src/features/popup/client.js';
import { createPopupStore, type PageAccess } from '../../../../src/features/popup/store.js';
import type { TabState } from '../../../../src/core/messaging/tabState.js';
import { TAB_STATES } from '../../../fixtures/panel/tabStates.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const OK: ClientResult<null> = { ok: true, data: null };

/** A worker that remembers the last level it was told (so re-reads reflect saved choices). */
function fakeClient(state: TabState = TAB_STATES.normal) {
  let current = state;
  const tabState = vi.fn<(tabId: number) => Promise<ClientResult<TabState>>>(() => Promise.resolve({ ok: true, data: current }));
  const command = vi.fn<(type: string, payload: unknown) => Promise<ClientResult<null>>>((_type, payload) => {
    const { level } = payload as { level: TabState['level'] | 'inherit' };
    if (level !== 'inherit') current = { ...current, level };
    return Promise.resolve(OK);
  });
  return { client: { tabState, command } as unknown as Client, tabState, command };
}

function fakePage(overrides: Partial<PageAccess> = {}): PageAccess {
  return {
    activeTabId: () => Promise.resolve(3),
    requestOrigins: () => Promise.resolve(true),
    reloadTab: () => Promise.resolve(),
    ...overrides,
  };
}

describe('panel store', () => {
  test('uses ?tabId= when given and does not ask for the active tab', async () => {
    const { client, tabState } = fakeClient();
    const activeTabId = vi.fn(() => Promise.resolve(3));
    const store = createPopupStore({ client, page: fakePage({ activeTabId }), tabIdFromUrl: 12 });
    expect(store.view.value).toEqual({ kind: 'loading' });
    await store.load();
    expect(tabState).toHaveBeenCalledWith(12);
    expect(activeTabId).not.toHaveBeenCalled();
    expect(store.view.value).toEqual({ kind: 'ready', tabId: 12, state: TAB_STATES.normal });
  });

  test('falls back to the active tab; no tab or a failed query is "unavailable"', async () => {
    const { client, tabState } = fakeClient();
    const withTab = createPopupStore({ client, page: fakePage(), tabIdFromUrl: null });
    await withTab.load();
    expect(tabState).toHaveBeenCalledWith(3);
    const noTab = createPopupStore({
      client,
      page: fakePage({ activeTabId: () => Promise.resolve(null) }),
      tabIdFromUrl: null,
    });
    await noTab.load();
    expect(noTab.view.value.kind).toBe('unavailable');
    const broken = createPopupStore({
      client,
      page: fakePage({ activeTabId: () => Promise.reject(new Error('x')) }),
      tabIdFromUrl: null,
    });
    await broken.load();
    expect(broken.view.value.kind).toBe('unavailable');
  });

  test('an error answer is "unavailable", not a guess', async () => {
    const client = {
      tabState: () => Promise.resolve({ ok: false, error: { code: 'not-implemented', message: 'x' } }),
      command: vi.fn(),
    } as unknown as Client;
    const store = createPopupStore({ client, page: fakePage(), tabIdFromUrl: 1 });
    await store.load();
    expect(store.view.value.kind).toBe('unavailable');
  });

  test('choosing a level shows it at once, sends c/setSiteLevel for the host and reports it saved', async () => {
    const { client, command } = fakeClient();
    const store = createPopupStore({ client, page: fakePage(), tabIdFromUrl: 1 });
    await store.load();
    const done = store.chooseLevel('thorough');
    expect(store.view.value).toMatchObject({
      state: { level: 'thorough', setOn: 'news.example.com' },
    });
    expect(store.status.value).toBe('Saving…');
    await done;
    expect(command).toHaveBeenCalledWith('c/setSiteLevel', {
      hostname: 'news.example.com',
      level: 'thorough',
    });
    expect(store.status.value).toBe('Saved. Reload the page in a few seconds to see the change.');
  });

  test('arrowing across levels while a command is in flight sends only the latest one next', async () => {
    const { client, command } = fakeClient();
    const first = deferred<ClientResult<null>>();
    command.mockImplementationOnce(() => first.promise);
    const store = createPopupStore({ client, page: fakePage(), tabIdFromUrl: 1 });
    await store.load();
    const a = store.chooseLevel('light');
    const b = store.chooseLevel('standard');
    const c = store.chooseLevel('thorough');
    first.resolve(OK);
    await Promise.all([a, b, c]);
    expect(command.mock.calls.map((call) => (call[1] as { level: string }).level)).toEqual(['light', 'thorough']);
    expect(store.view.value).toMatchObject({ state: { level: 'thorough' } });
  });

  test('a refused change is reported and the real state is read again', async () => {
    const { client, command, tabState } = fakeClient();
    command.mockResolvedValueOnce({ ok: false, error: { code: 'refused', message: 'x' } });
    const store = createPopupStore({ client, page: fakePage(), tabIdFromUrl: 1 });
    await store.load();
    await store.chooseLevel('light');
    expect(store.status.value).toBe('Could not save the change. Try again.');
    expect(tabState).toHaveBeenCalledTimes(2);
    expect(store.view.value).toMatchObject({ state: { level: 'standard' } });
  });

  test('a command the worker does not have yet says so', async () => {
    const { client, command } = fakeClient();
    command.mockResolvedValueOnce({ ok: false, error: { code: 'not-implemented', message: 'x' } });
    const store = createPopupStore({ client, page: fakePage(), tabIdFromUrl: 1 });
    await store.load();
    await store.chooseLevel('light');
    expect(store.status.value).toBe('This is not available yet.');
  });

  test('without a known host nothing is sent', async () => {
    const { client, command } = fakeClient({ ...TAB_STATES.reduced, host: null });
    const store = createPopupStore({ client, page: fakePage(), tabIdFromUrl: 1 });
    await store.chooseLevel('light');
    await store.load();
    await store.chooseLevel('light');
    await store.act('allowSite');
    expect(command).not.toHaveBeenCalled();
  });

  test('"Allow on this site" asks Chrome synchronously in the click, for this host only, then re-reads', async () => {
    const { client, tabState } = fakeClient(TAB_STATES.reduced);
    const requestOrigins = vi.fn(() => Promise.resolve(true));
    const store = createPopupStore({ client, page: fakePage({ requestOrigins }), tabIdFromUrl: 1 });
    await store.load();
    const done = store.act('allowSite');
    expect(requestOrigins).toHaveBeenCalledWith(['*://news.example.com/*']);
    await done;
    expect(store.status.value).toBe('Site access allowed.');
    expect(tabState).toHaveBeenCalledTimes(2);
  });

  test('"Allow on all sites" asks for <all_urls>; a refusal or an error is reported, nothing re-read', async () => {
    const { client, tabState } = fakeClient(TAB_STATES.limited);
    const requestOrigins = vi.fn(() => Promise.resolve(false));
    const store = createPopupStore({ client, page: fakePage({ requestOrigins }), tabIdFromUrl: 1 });
    await store.load();
    await store.act('allowAll');
    expect(requestOrigins).toHaveBeenCalledWith(['<all_urls>']);
    expect(store.status.value).toBe('Site access was not allowed.');
    requestOrigins.mockImplementationOnce(() => Promise.reject(new Error('not in a gesture')));
    await store.act('allowAll');
    expect(store.status.value).toBe('Site access was not allowed.');
    expect(tabState).toHaveBeenCalledTimes(1);
  });

  test('"Turn back on" clears the level where it was set (a parent domain too)', async () => {
    const { client, command } = fakeClient({ ...TAB_STATES.off, setOn: 'example.com' });
    const store = createPopupStore({ client, page: fakePage(), tabIdFromUrl: 1 });
    await store.load();
    await store.act('turnOn');
    expect(command).toHaveBeenCalledWith('c/setSiteLevel', {
      hostname: 'example.com',
      level: 'inherit',
    });
  });

  test('an action without a command yet says so; actions before loading do nothing', async () => {
    const { client, command } = fakeClient(TAB_STATES.reset);
    const store = createPopupStore({ client, page: fakePage(), tabIdFromUrl: 1 });
    await store.act('restore');
    expect(store.status.value).toBe('');
    await store.load();
    await store.act('restore');
    expect(store.status.value).toBe('This is not available yet.');
    expect(command).not.toHaveBeenCalled();
  });

  test('a slow read that started before a level choice does not undo it', async () => {
    const { client, tabState } = fakeClient();
    const store = createPopupStore({ client, page: fakePage(), tabIdFromUrl: 1 });
    await store.load();
    const slow = deferred<ClientResult<TabState>>();
    tabState.mockImplementationOnce(() => slow.promise);
    const staleRead = store.load();
    await store.chooseLevel('thorough');
    slow.resolve({ ok: true, data: TAB_STATES.normal });
    await staleRead;
    expect(store.view.value).toMatchObject({ state: { level: 'thorough' } });
  });

  test('a failed re-read keeps the panel and says so', async () => {
    const { client, tabState } = fakeClient();
    const store = createPopupStore({ client, page: fakePage(), tabIdFromUrl: 1 });
    await store.load();
    tabState.mockResolvedValueOnce({ ok: false, error: { code: 'no-answer', message: 'x' } });
    await store.chooseLevel('light');
    expect(store.view.value.kind).toBe('ready');
    expect(store.status.value).toBe('Could not read the state of this tab. Close this panel and open it again.');
  });

  test('a synchronous throw from Chrome counts as "not allowed"; a double click asks once', async () => {
    const { client } = fakeClient(TAB_STATES.reduced);
    const requestOrigins = vi.fn<(origins: readonly string[]) => Promise<boolean>>(() => {
      throw new Error('invalid pattern');
    });
    const store = createPopupStore({ client, page: fakePage({ requestOrigins }), tabIdFromUrl: 1 });
    await store.load();
    await Promise.all([store.act('allowSite'), store.act('allowSite')]);
    expect(requestOrigins).toHaveBeenCalledTimes(1);
    expect(store.status.value).toBe('Site access was not allowed.');
  });

  test('no action runs while a level is being saved', async () => {
    const { client, command } = fakeClient({ ...TAB_STATES.normal });
    const first = deferred<ClientResult<null>>();
    command.mockImplementationOnce(() => first.promise);
    const store = createPopupStore({ client, page: fakePage(), tabIdFromUrl: 1 });
    await store.load();
    const saving = store.chooseLevel('light');
    await store.act('turnOn');
    first.resolve(OK);
    await saving;
    expect(command).toHaveBeenCalledTimes(1);
  });
});
