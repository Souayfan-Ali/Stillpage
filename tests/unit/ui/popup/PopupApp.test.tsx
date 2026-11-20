// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Client, ClientResult } from '../../../../src/features/popup/client.js';
import type { HeaderKind } from '../../../../src/features/popup/header.js';
import { PopupApp } from '../../../../src/features/popup/PopupApp.js';
import { createPopupStore, type PopupStore } from '../../../../src/features/popup/store.js';
import type { TabState } from '../../../../src/core/messaging/tabState.js';
import { HEADER_BUTTONS, HEADER_TEXT, NOW, TAB_STATES } from '../../../fixtures/panel/tabStates.js';
import { axeViolations } from '../axe.js';

afterEach(cleanup);

const KINDS = Object.keys(TAB_STATES) as HeaderKind[];

function setup(state: TabState | null) {
  let current = state;
  const command = vi.fn<(type: string, payload: unknown) => Promise<ClientResult<null>>>((_type, payload) => {
    const { level } = payload as { level?: TabState['level'] | 'inherit' };
    if (current !== null && level !== undefined) current = level === 'inherit' ? { ...current, level: 'standard', setOn: null } : { ...current, level, setOn: current.host };
    return Promise.resolve({ ok: true, data: null });
  });
  const client = {
    tabState: () => Promise.resolve(current === null ? { ok: false, error: { code: 'refused', message: 'x' } } : { ok: true, data: current }),
    command,
  } as unknown as Client;
  const requestOrigins = vi.fn(() => Promise.resolve(true));
  const reloadTab = vi.fn(() => Promise.resolve());
  const store = createPopupStore({
    client,
    page: { activeTabId: () => Promise.resolve(1), requestOrigins, reloadTab },
    tabIdFromUrl: 1,
  });
  return { store, command, requestOrigins, reloadTab };
}

async function mount(store: PopupStore, applyTheme?: (t: TabState['theme']) => void) {
  const view = render(<PopupApp store={store} now={() => NOW} {...(applyTheme ? { applyTheme } : {})} />);
  await store.load();
  return view;
}

describe('toolbar panel', () => {
  test('renders its shell before any answer: name, heading and a loading line', () => {
    const { store } = setup(TAB_STATES.normal);
    render(<PopupApp store={store} now={() => NOW} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Glassmere');
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  test.each(KINDS)('%s: draws the planned text and buttons with no axe violations', async (kind) => {
    const { store } = setup(TAB_STATES[kind]);
    const { container } = await mount(store);
    const state = container.querySelector(`[data-state="${kind}"]`);
    expect(state?.textContent).toContain(HEADER_TEXT[kind]);
    // "Hide something" (P2-21) is shown on every page with a host; the header's own buttons are checked here.
    expect(screen.queryAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Hide something')).toEqual(HEADER_BUTTONS[kind]);
    expect(await axeViolations(container)).toEqual([]);
  });

  test('"Hide something" starts the picker in this tab and closes the panel (P2-21)', async () => {
    const { store, command } = setup(TAB_STATES.normal);
    await mount(store);
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Hide something' }));
    await vi.waitFor(() => { expect(close).toHaveBeenCalled(); });
    expect(command).toHaveBeenCalledWith('c/startPicker', { tabId: 1, mode: 'hide' });
    close.mockRestore();
  });

  test.each(['normal', 'reduced'] as const)('%s: only the state text is a live region, never the heading, buttons or radios', async (kind) => {
    const { store } = setup(TAB_STATES[kind]);
    await mount(store);
    const regions = screen.getAllByRole('status');
    expect(regions[0]?.textContent).toBe(HEADER_TEXT[kind]);
    expect(regions.every((r) => r.querySelector('input, button, h2') === null)).toBe(true);
  });

  test('after an action removes the focused button, focus moves to the host heading', async () => {
    const { store } = setup(TAB_STATES.off);
    await mount(store);
    const button = screen.getByRole('button', { name: 'Turn back on' });
    button.focus();
    fireEvent.click(button);
    await vi.waitFor(() => {
      expect(document.activeElement?.tagName).toBe('H2');
    });
  });

  test('shows the host as a heading, or "Not available here" when the address is not known', async () => {
    const { store } = setup({ ...TAB_STATES.reduced, host: null });
    await mount(store);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Not available here');
    expect(screen.getAllByRole('radio').every((r) => r.matches(':disabled'))).toBe(true);
    expect(screen.getByText('Open a website in this tab to choose a level.')).toBeTruthy();
  });

  test('the level selector shows the effective level and its description', async () => {
    const { store } = setup(TAB_STATES.normal);
    await mount(store);
    const standard = screen.getByRole<HTMLInputElement>('radio', { name: 'Standard' });
    expect(standard.checked).toBe(true);
    const group = screen.getByRole('group', { name: 'Protection on this site' });
    const description = document.getElementById((group.getAttribute('aria-describedby') ?? '').split(' ')[0] ?? '');
    expect(description?.textContent).toBe('Also hides leftover ad boxes and stops ad scripts.');
  });

  test('choosing Light sends the command, updates the description and announces the result', async () => {
    const { store, command } = setup(TAB_STATES.normal);
    await mount(store);
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    await vi.waitFor(() => {
      expect(screen.getByText('Saved. Reload the page in a few seconds to see the change.')).toBeTruthy();
    });
    expect(command).toHaveBeenCalledWith('c/setSiteLevel', {
      hostname: 'news.example.com',
      level: 'light',
    });
    expect(screen.getByText('Blocks network requests only. Use when a page misbehaves.')).toBeTruthy();
  });

  test('names the parent domain that caps the level', async () => {
    const { store } = setup({
      ...TAB_STATES.normal,
      host: 'shop.example.com',
      setOn: 'example.com',
      level: 'light',
    });
    await mount(store);
    expect(screen.getByText('Set on example.com. A site cannot be set higher than example.com.')).toBeTruthy();
  });

  test('the reduced-mode banner asks Chrome for this site from the click', async () => {
    const { store, requestOrigins } = setup(TAB_STATES.reduced);
    await mount(store);
    fireEvent.click(screen.getByRole('button', { name: 'Allow on this site' }));
    expect(requestOrigins).toHaveBeenCalledWith(['*://news.example.com/*']);
  });

  test('an unreadable tab state says so instead of guessing', async () => {
    const { store } = setup(null);
    const { container } = await mount(store);
    expect(container.querySelector('[data-state="unavailable"]')?.textContent).toContain('Could not read the state of this tab');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  test('applies the theme setting once the state is known', async () => {
    const applyTheme = vi.fn();
    const { store } = setup({ ...TAB_STATES.normal, theme: 'dark' });
    await mount(store, applyTheme);
    await vi.waitFor(() => {
      expect(applyTheme).toHaveBeenLastCalledWith('dark');
    });
  });
});

describe('toolbar panel: P2-10 pause menu, reload, dismiss, retry line, footer', () => {
  test('the pause menu is a disclosure: closed, opened, Escape closes and returns focus', async () => {
    const { store } = setup(TAB_STATES.normal);
    const { container } = await mount(store);
    const trigger = screen.getByRole('button', { name: 'Pause on this site' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector(`#${trigger.getAttribute('aria-controls') ?? 'x'}`)?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // "Hide something" (P2-21) is the panel's own button, outside the pause menu.
    expect(screen.getAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Hide something')).toEqual(['Pause on this site', '30 minutes', '1 hour', 'Until I turn it back on']);
    expect(await axeViolations(container)).toEqual([]);
    const thirty = screen.getByRole('button', { name: '30 minutes' });
    thirty.focus();
    fireEvent.keyDown(thirty, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  test.each([
    ['30 minutes', 30],
    ['1 hour', 60],
    ['Until I turn it back on', null],
  ] as const)('choosing "%s" sends c/pauseSite and offers a reload of the tab', async (label, minutes) => {
    const { store, command, reloadTab } = setup(TAB_STATES.normal);
    await mount(store);
    fireEvent.click(screen.getByRole('button', { name: 'Pause on this site' }));
    fireEvent.click(screen.getByRole('button', { name: label }));
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy();
    });
    expect(command).toHaveBeenCalledWith('c/pauseSite', { hostname: 'news.example.com', minutes });
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    await vi.waitFor(() => {
      expect(screen.getByText('Page reloaded.')).toBeTruthy();
    });
    expect(reloadTab).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('button', { name: 'Reload page' })).toBeNull();
  });

  test('no pause menu where the site is off, paused, restricted or has no address', async () => {
    for (const state of [TAB_STATES.off, TAB_STATES.paused, TAB_STATES.restricted, { ...TAB_STATES.reduced, host: null }]) {
      const { store } = setup(state);
      await mount(store);
      expect(screen.queryByRole('button', { name: 'Pause on this site' })).toBeNull();
      cleanup();
    }
  });

  test('a failed reload says so', async () => {
    const deps = setup(TAB_STATES.normal);
    deps.reloadTab.mockRejectedValueOnce(new Error('gone'));
    await mount(deps.store);
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    await vi.waitFor(() => {
      expect(screen.getByText('Could not reload the page.')).toBeTruthy();
    });
  });

  test('D-32: the reset notice is dismissed with c/dismissNotice', async () => {
    const { store, command } = setup(TAB_STATES.reset);
    await mount(store);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await vi.waitFor(() => {
      expect(command).toHaveBeenCalledWith('c/dismissNotice', {});
    });
    expect(screen.queryByRole('button', { name: 'Restore a backup' })).toBeNull();
  });

  test('D-31: a failed last run adds a static warning line under the state, not a live region', async () => {
    const { store } = setup({ ...TAB_STATES.off, lastRun: 'failed' });
    const { container } = await mount(store);
    const line = container.querySelector('[data-state="retrying"]');
    expect(line?.textContent).toBe('Part of the protection could not be applied. It will be tried again.');
    expect(line?.closest('[role="status"]')).toBeNull();
    expect(line?.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-state="off"]')).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test('footer: rules date from the version, or the version when it carries none', () => {
    const { store } = setup(TAB_STATES.normal);
    render(<PopupApp store={store} now={() => NOW} version="1.0.317.600" />);
    expect(screen.getByRole('contentinfo').textContent).toBe('Rules from 13 Nov 2026');
    cleanup();
    render(<PopupApp store={store} now={() => NOW} version="0.0.1" />);
    expect(screen.getByRole('contentinfo').textContent).toBe('Version 0.0.1');
  });

  test('footer link to the hidden-items list (P2-22, D-91): "Hidden items" without a count, opened in a new tab', async () => {
    const { store } = setup({ ...TAB_STATES.normal, hidden: ['#a', '#b'] });
    const { container } = render(<PopupApp store={store} now={() => NOW} version="1.0.317.600" />);
    await store.load();
    const link = await screen.findByRole('link', { name: 'Hidden items' });
    expect(link.getAttribute('href')).toBe('/dashboard.html#hidden');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.closest('footer')).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test.each([
    [1, 'web', 'Hidden items'],
    [0, 'web', 'Hidden items'],
    [0, 'restricted', 'Hidden items'],
  ] as const)('footer link with %i on a %s page: "%s"', async (hidden, kind, text) => {
    const { store } = setup({ ...(kind === 'web' ? TAB_STATES.normal : TAB_STATES.restricted), hidden: Array.from({ length: hidden }, (_, i) => `#h${String(i)}`) });
    render(<PopupApp store={store} now={() => NOW} version="1.0.317.600" />);
    await store.load();
    expect((await screen.findByRole('link', { name: text })).getAttribute('href')).toBe('/dashboard.html#hidden');
  });
});
