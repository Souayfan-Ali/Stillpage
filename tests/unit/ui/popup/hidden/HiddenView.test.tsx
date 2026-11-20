// @vitest-environment jsdom
/**
 * P2-22b "Show on page" in the toolbar panel: the entry in the main view, the per-site list (text only),
 * the toggle that injects the packaged function with the selector as data, the status line, the revert
 * on the timer / on leaving / on `pagehide`, and axe.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Client } from '../../../../../src/features/popup/client.js';
import type { HiddenDeps } from '../../../../../src/features/popup/hidden/HiddenView.js';
import { createPreview, SHOW_MS } from '../../../../../src/features/popup/hidden/preview.js';
import { showOnPage } from '../../../../../src/features/popup/hidden/showOnPage.js';
import { PopupApp } from '../../../../../src/features/popup/PopupApp.js';
import { createPopupStore } from '../../../../../src/features/popup/store.js';
import type { TabState } from '../../../../../src/core/messaging/tabState.js';
import { NOW, TAB_STATES } from '../../../../fixtures/panel/tabStates.js';
import { axeViolations } from '../../axe.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const TAB = 7;
const SELECTORS = ['#ad', '.banner'];

function setup(state: TabState, answer: (args: unknown[]) => Promise<unknown> = () => Promise.resolve({ shown: 2 })) {
  const client = { tabState: () => Promise.resolve({ ok: true, data: state }), command: vi.fn() } as unknown as Client;
  const store = createPopupStore({ client, page: { activeTabId: () => Promise.resolve(TAB), requestOrigins: vi.fn(), reloadTab: vi.fn() }, tabIdFromUrl: TAB });
  const inject = vi.fn<HiddenDeps['inject']>((_tab, _func, args) => answer(args));
  return { store, inject };
}

async function openView(state: TabState = { ...TAB_STATES.normal, hidden: SELECTORS }, answer?: (args: unknown[]) => Promise<unknown>) {
  const { store, inject } = setup(state, answer);
  // With a version the panel draws its footer, as it does in the product.
  const view = render(<PopupApp store={store} now={() => NOW} hidden={{ inject }} version="1.0.317.600" />);
  await store.load();
  fireEvent.click(await screen.findByRole('button', { name: 'What you hid on this site (2)' }));
  await screen.findByRole('heading', { level: 2, name: 'Hidden on news.example.com' });
  return { view, inject, store };
}

const showButton = (selector: string): HTMLElement => screen.getByRole('button', { name: `Show on page: ${selector}` });

describe('the entry in the main view (P2-22b)', () => {
  test.each([
    ['nothing hidden here', { ...TAB_STATES.normal, hidden: [] }],
    ['a restricted page', { ...TAB_STATES.restricted, hidden: ['#ad'] }],
    ['a page without a host', { ...TAB_STATES.normal, host: null, hidden: ['#ad'] }],
  ] satisfies [string, TabState][])('is not drawn on %s', async (_name, state) => {
    const { store, inject } = setup(state);
    render(<PopupApp store={store} now={() => NOW} hidden={{ inject }} />);
    await store.load();
    await screen.findAllByRole('status');
    expect(screen.queryByRole('button', { name: /What you hid/ })).toBeNull();
  });

  test('is not drawn without the inject port', async () => {
    const { store } = setup({ ...TAB_STATES.normal, hidden: SELECTORS });
    render(<PopupApp store={store} now={() => NOW} />);
    await store.load();
    await screen.findAllByRole('status');
    expect(screen.queryByRole('button', { name: /What you hid/ })).toBeNull();
  });
});

describe('the view (P2-22b)', () => {
  test('lists the items as text, focuses its heading, has no dashboard link of its own (D-103) and passes axe', async () => {
    const { view } = await openView();
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Hidden on news.example.com');
    });
    expect([...view.container.querySelectorAll('li code')].map((c) => c.textContent)).toEqual(SELECTORS);
    expect(showButton('#ad').getAttribute('aria-pressed')).toBe('false');
    expect(showButton('#ad').textContent).toBe('Show on page');
    // D-103: the footer's "Hidden items" is the one path to the dashboard's list.
    expect(screen.queryByRole('link', { name: 'Manage things you hid' })).toBeNull();
    expect(view.container.querySelector('section[aria-labelledby="hidden-title"] a')).toBeNull();
    const footer = screen.getByRole('link', { name: 'Hidden items' });
    expect(footer.getAttribute('href')).toBe('/dashboard.html#hidden');
    expect(footer.closest('footer')).not.toBeNull();
    expect(await axeViolations(view.container)).toEqual([]);
  });

  test('a selector with markup is drawn as text, never as markup', async () => {
    const hostile = 'div[title="<img src=x onerror=alert(1)>"]';
    const { view } = await openView({ ...TAB_STATES.normal, hidden: [hostile, '#b'] });
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('li code')?.textContent).toBe(hostile);
  });

  test('Show injects the packaged function into this tab with the selector as data, then says how it went', async () => {
    const { inject, view } = await openView();
    fireEvent.click(showButton('#ad'));
    await screen.findByText('Shown on the page: 2 matches. Hidden again in 20 seconds.');
    expect(inject).toHaveBeenCalledWith(TAB, showOnPage, ['#ad', SHOW_MS, 'news.example.com']);
    expect(showButton('#ad').getAttribute('aria-pressed')).toBe('true');
    expect(showButton('.banner').getAttribute('aria-pressed')).toBe('false');
    expect(await axeViolations(view.container)).toEqual([]);
  });

  test('pressing it again stops the preview (selector null) and says so', async () => {
    const { inject } = await openView();
    fireEvent.click(showButton('#ad'));
    await screen.findByText(/Shown on the page/);
    fireEvent.click(showButton('#ad'));
    await screen.findByText('Hidden again.');
    expect(inject).toHaveBeenLastCalledWith(TAB, showOnPage, [null, 0, 'news.example.com']);
    expect(showButton('#ad').getAttribute('aria-pressed')).toBe('false');
  });

  test.each([
    ['no match', () => Promise.resolve({ shown: 0 }), 'Nothing on this page matches right now.'],
    ['a refused selector', () => Promise.resolve({ error: 'invalid' }), 'Can’t show it on this page.'],
    ['a page Chrome does not let us into', () => Promise.reject(new Error('Cannot access contents of the page')), 'Can’t show it on this page.'],
    ['an answer of the wrong shape', () => Promise.resolve({ shown: -1, extra: true }), 'Can’t show it on this page.'],
    ['no answer', () => Promise.resolve(undefined), 'Can’t show it on this page.'],
  ] as const)('%s: says so and stays unpressed', async (_name, answer, text) => {
    await openView(undefined, answer);
    fireEvent.click(showButton('#ad'));
    await screen.findByText(text);
    expect(showButton('#ad').getAttribute('aria-pressed')).toBe('false');
  });

  test('Back reverts the page and returns focus to the entry', async () => {
    const { inject } = await openView();
    fireEvent.click(showButton('#ad'));
    await screen.findByText(/Shown on the page/);
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain('What you hid on this site (2)');
    });
    expect(inject).toHaveBeenLastCalledWith(TAB, showOnPage, [null, 0, 'news.example.com']);
  });

  test('the panel going away (pagehide) reverts the page', async () => {
    const { inject } = await openView();
    fireEvent.click(showButton('.banner'));
    await screen.findByText(/Shown on the page/);
    dispatchEvent(new Event('pagehide'));
    expect(inject).toHaveBeenLastCalledWith(TAB, showOnPage, [null, 0, 'news.example.com']);
  });

  test('leaving the view with nothing shown injects nothing', async () => {
    const { inject } = await openView();
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    await screen.findByRole('button', { name: /What you hid/ });
    expect(inject).not.toHaveBeenCalled();
  });
});

/** The panel with a worker whose `c/removeUserFilter` changes what the next `q/tabState` reports. */
async function openRemovable(ok = true) {
  let hidden = [...SELECTORS];
  const client = { tabState: () => Promise.resolve({ ok: true, data: { ...TAB_STATES.normal, hidden } }), command: vi.fn() } as unknown as Client;
  const store = createPopupStore({ client, page: { activeTabId: () => Promise.resolve(TAB), requestOrigins: vi.fn(), reloadTab: vi.fn() }, tabIdFromUrl: TAB });
  const inject = vi.fn<HiddenDeps['inject']>(() => Promise.resolve({ shown: 1 }));
  const remove = vi.fn<NonNullable<HiddenDeps['remove']>>((_host, selector) => {
    if (ok) hidden = hidden.filter((s) => s !== selector);
    return Promise.resolve(ok);
  });
  const view = render(<PopupApp store={store} now={() => NOW} hidden={{ inject, remove }} />);
  await store.load();
  fireEvent.click(await screen.findByRole('button', { name: 'What you hid on this site (2)' }));
  await screen.findByRole('heading', { level: 2, name: 'Hidden on news.example.com' });
  return { view, remove, inject };
}

const removeButton = (selector: string): HTMLElement => screen.getByRole('button', { name: `Remove ${selector} on news.example.com` });
const listed = (view: { readonly container: Element }): readonly (string | null)[] => [...view.container.querySelectorAll('li code')].map((c) => c.textContent);

describe('Remove in the panel (P3-17 item 3)', () => {
  test('each item has a Remove button named after it; no Remove without the port', async () => {
    const { view } = await openRemovable();
    expect(removeButton('#ad').textContent).toBe('Remove');
    expect(removeButton('#ad').tagName).toBe('BUTTON');
    expect(await axeViolations(view.container)).toEqual([]);
    cleanup();
    await openView();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  test('Remove sends c/removeUserFilter for this host, drops the item, says so, and moves focus to the next Remove', async () => {
    const { view, remove } = await openRemovable();
    fireEvent.click(removeButton('#ad'));
    await screen.findByText('Removed. It shows again on that site. If a page still hides it, reload that page.');
    expect(remove).toHaveBeenCalledWith('news.example.com', '#ad');
    expect(listed(view)).toEqual(['.banner']);
    await waitFor(() => {
      expect(document.activeElement).toBe(removeButton('.banner'));
    });
    expect(await axeViolations(view.container)).toEqual([]);
  });

  test('removing the last item leaves the view open with a note; focus goes to the heading; Back shows no entry', async () => {
    const { view } = await openRemovable();
    fireEvent.click(removeButton('#ad'));
    await waitFor(() => { expect(listed(view)).toEqual(['.banner']); });
    fireEvent.click(removeButton('.banner'));
    await screen.findByText('Nothing is hidden on this site now.');
    expect(listed(view)).toEqual([]);
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Hidden on news.example.com');
    });
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    await waitFor(() => { expect(screen.queryByRole('button', { name: /What you hid/ })).toBeNull(); });
  });

  test('a refused removal keeps the item and says nothing changed', async () => {
    const { view } = await openRemovable(false);
    fireEvent.click(removeButton('#ad'));
    await screen.findByText('Couldn’t remove it. Nothing was changed.');
    expect(listed(view)).toEqual(SELECTORS);
  });

  test('removing the item being shown stops the preview first', async () => {
    const { inject } = await openRemovable();
    fireEvent.click(showButton('#ad'));
    await screen.findByText(/Shown on the page/);
    fireEvent.click(removeButton('#ad'));
    await screen.findByText(/^Removed\./);
    expect(inject).toHaveBeenLastCalledWith(TAB, showOnPage, [null, 0, 'news.example.com']);
  });
});

describe('createPreview (P2-22b)', () => {
  test('the timer ends the preview on the panel side too', async () => {
    vi.useFakeTimers();
    const inject = vi.fn(() => Promise.resolve({ shown: 1 }));
    const preview = createPreview(inject);
    await preview.toggle('#ad');
    expect(preview.active.value).toBe('#ad');
    expect(preview.status.value).toBe('Shown on the page: 1 match. Hidden again in 20 seconds.');
    vi.advanceTimersByTime(SHOW_MS);
    expect(preview.active.value).toBeNull();
    expect(preview.status.value).toBe('Hidden again.');
    expect(inject).toHaveBeenCalledTimes(1);
  });

  test('one toggle at a time: a press while one is pending is ignored', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    const inject = vi.fn(() => new Promise((r) => { resolve = r; }));
    const preview = createPreview(inject);
    const first = preview.toggle('#a');
    await preview.toggle('#b');
    resolve({ shown: 1 });
    await first;
    expect(inject).toHaveBeenCalledTimes(1);
    expect(preview.active.value).toBe('#a');
  });

  test('showing another item replaces the first (the page reverts it), with one injection', async () => {
    const inject = vi.fn(() => Promise.resolve({ shown: 1 }));
    const preview = createPreview(inject);
    await preview.toggle('#a');
    await preview.toggle('#b');
    expect(preview.active.value).toBe('#b');
    expect(inject.mock.calls).toEqual([['#a', SHOW_MS], ['#b', SHOW_MS]]);
  });

  test('stop never throws when the tab is gone', async () => {
    const inject = vi.fn((selector: string | null) => (selector === null ? Promise.reject(new Error('No tab with id')) : Promise.resolve({ shown: 1 })));
    const preview = createPreview(inject);
    await preview.toggle('#a');
    expect(() => {
      preview.stop();
    }).not.toThrow();
    expect(preview.active.value).toBeNull();
    await Promise.resolve();
  });
});
