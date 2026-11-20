// @vitest-environment jsdom
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PopupLog } from '../../../../src/core/popup/log.js';
import type { Client } from '../../../../src/features/popup/client.js';
import { PopupApp } from '../../../../src/features/popup/PopupApp.js';
import { createPopupStore } from '../../../../src/features/popup/store.js';
import type { TabState } from '../../../../src/core/messaging/tabState.js';
import { NOW, TAB_STATES } from '../../../fixtures/panel/tabStates.js';
import { axeViolations } from '../axe.js';

afterEach(cleanup);
// The row is its own chunk: its first load can take longer than the 1 s default under machine load.
configure({ asyncUtilTimeout: 5_000 });

function mount(state: TabState, log: PopupLog | null) {
  const siteCommand = vi.fn(() => Promise.resolve({ ok: true as const, data: { ownLevel: null, popupPolicy: 'allow' as const, pausedUntil: null } }));
  const client = { tabState: () => Promise.resolve({ ok: true, data: state }), command: () => Promise.resolve({ ok: true, data: null }), siteCommand } as unknown as Client;
  const openTab = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
  const popupLog = vi.fn<(tabId: number) => Promise<PopupLog | null>>(() => Promise.resolve(log));
  const store = createPopupStore({ client, page: { activeTabId: () => Promise.resolve(5), requestOrigins: () => Promise.resolve(true), reloadTab: () => Promise.resolve() }, tabIdFromUrl: 5 });
  const view = render(<PopupApp store={store} now={() => NOW} popupRow={{ client, popupLog, openTab }} />);
  return { view, store, siteCommand, openTab, popupLog };
}

describe('toolbar panel pop-up row (P2-60b)', () => {
  test('policy select (Strict disabled while the guard does not ship, with the note); a choice sends c/setSitePopupPolicy', async () => {
    const r = mount(TAB_STATES.normal, { hosts: [], blocked: 0, codes: [] });
    await r.store.load();
    const select = await screen.findByLabelText<HTMLSelectElement>('Pop-ups on this site');
    expect([...select.options].map((o) => [o.value, o.textContent, o.disabled])).toEqual([
      ['inherit', 'Default (Off)', false],
      ['allow', 'Allowed', false],
      ['strict', 'Strict', true],
    ]);
    // D-90: guard off → exactly one note, and nothing from the page's sentinel (no count, no "none", no "cannot run").
    const row = r.view.container.querySelector('[data-state="popup-row"]');
    await vi.waitFor(() => {
      expect(r.popupLog).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...(row?.querySelectorAll('p:not([role="status"])') ?? [])].map((p) => p.textContent)).toEqual(['Only "Allowed" has an effect in this version.']);
    expect(screen.queryByText('No pop-ups blocked on this page.')).toBeNull();
    expect(screen.queryByRole('button', { name: /blocked here/ })).toBeNull();
    fireEvent.change(select, { target: { value: 'allow' } });
    await vi.waitFor(() => {
      expect(r.siteCommand).toHaveBeenCalledWith('c/setSitePopupPolicy', { hostname: 'news.example.com', policy: 'allow' });
    });
    expect(await axeViolations(r.view.container)).toEqual([]);
  });

  test('count and list from the page sentinel; each host opens in a new tab; axe clean with the list open', async () => {
    const r = mount({ ...TAB_STATES.normal, popupGuard: true }, { hosts: ['ad.example', 'pop.example'], blocked: 3, codes: ['G11'] });
    await r.store.load();
    const toggle = await screen.findByRole('button', { name: '3 blocked here' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Open pop.example' }));
    await vi.waitFor(() => {
      expect(r.openTab).toHaveBeenCalledWith('https://pop.example/');
    });
    expect((await screen.findByLabelText<HTMLSelectElement>('Pop-ups on this site')).options[2]?.disabled).toBe(false);
    expect(await axeViolations(r.view.container)).toEqual([]);
  });

  test('guard off and a count from the page: still only the one note, no Blocked part (D-90)', async () => {
    const r = mount(TAB_STATES.normal, { hosts: ['ad.example'], blocked: 2, codes: [] });
    await r.store.load();
    await screen.findByText('Only "Allowed" has an effect in this version.');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: '2 blocked here' })).toBeNull();
    expect(screen.queryByText('Pop-up blocking is not running on this page. Reloading the page may start it.')).toBeNull();
  });

  test('no sentinel on the page says so while blocking should run (guard on, Smart, one note); no row at Light, Off or on restricted pages', async () => {
    const r = mount({ ...TAB_STATES.normal, popupGuard: true, popupMode: 'smart' }, null);
    await r.store.load();
    expect(await screen.findByText('Pop-up blocking is not running on this page. Reloading the page may start it.')).toBeTruthy();
    expect(screen.queryByText(/has an effect in this version/)).toBeNull();
    cleanup();
    for (const state of [{ ...TAB_STATES.normal, level: 'light' as const }, TAB_STATES.off, TAB_STATES.restricted]) {
      const other = mount(state, null);
      await other.store.load();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByLabelText('Pop-ups on this site')).toBeNull();
      cleanup();
    }
  });
  // D-107: the note says blocking cannot run only where it should be running.
  const quiet = async (state: TabState, log: PopupLog | null) => {
    const r = mount(state, log);
    await r.store.load();
    await screen.findByLabelText('Pop-ups on this site');
    await vi.waitFor(() => {
      expect(r.popupLog).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [...(r.view.container.querySelector('[data-state="popup-row"]')?.querySelectorAll('p:not([role="status"])') ?? [])].map((p) => p.textContent);
  };
  const guarded = { ...TAB_STATES.normal, popupGuard: true };

  test('D-107: pop-ups Off at Default and no sentinel: no note', async () => {
    expect(await quiet({ ...guarded, popupMode: 'off' }, null)).toEqual([]);
  });

  test('D-107: Allowed on this site and no sentinel: no note, whatever the mode', async () => {
    expect(await quiet({ ...guarded, popupMode: 'smart', site: { ownLevel: null, popupPolicy: 'allow', pausedUntil: null } }, null)).toEqual([]);
  });

  test('D-107/D-114: Smart and no sentinel: not running, a reload may start it', async () => {
    expect(await quiet({ ...guarded, popupMode: 'smart' }, null)).toEqual(['Pop-up blocking is not running on this page. Reloading the page may start it.']);
  });

  test('D-114: Strict on this site, mode Off, no sentinel (the page loaded before the choice): not running, a reload may start it', async () => {
    expect(await quiet({ ...guarded, popupMode: 'off', site: { ownLevel: null, popupPolicy: 'strict', pausedUntil: null } }, null)).toEqual([
      'Pop-up blocking is not running on this page. Reloading the page may start it.',
    ]);
  });

  test('D-107: Off, but a sentinel answers (a site on the packaged strict list): its count shows', async () => {
    const r = mount({ ...guarded, popupMode: 'off' }, { hosts: ['ad.example'], blocked: 2, codes: [] });
    await r.store.load();
    expect(await screen.findByRole('button', { name: '2 blocked here' })).toBeTruthy();
  });
});
