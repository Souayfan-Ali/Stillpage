// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { JSX } from 'preact';
import { afterEach, describe, expect, test } from 'vitest';
import type { Dashboard } from '../../../../src/core/messaging/dashboard.js';
import { HiddenSection } from '../../../../src/features/dashboard/hidden/HiddenSection.js';
import { sectionOf } from '../../../../src/features/dashboard/route.js';
import { createDashboardStore } from '../../../../src/features/dashboard/store.js';
import { SECTIONS, SECTION_TITLES } from '../../../../src/features/dashboard/strings.js';
import { axeViolations } from '../../ui/axe.js';
import { dashboard, scripted } from './fixtures.js';

afterEach(cleanup);

type Hidden = NonNullable<Dashboard['hidden']>;
const TWO_SITES: Hidden = [
  { host: 'news.example', selectors: ['#ad', '.promo'] },
  { host: 'shop.example', selectors: ['#chat'] },
];

/** A store whose `q/dashboard` answers `current` (a remove drops the selector from it, as the worker would). */
async function mount(hidden: Dashboard['hidden'], answers: Parameters<typeof scripted>[1] = {}) {
  let current = dashboard({ hidden });
  const request = scripted(() => current, answers);
  const store = createDashboardStore({ request, requestOrigins: () => Promise.resolve(true) });
  await store.load();
  // As in the shell: the section is drawn from the store's snapshot, read again after every command.
  const Shell = (): JSX.Element | null => {
    const snapshot = store.snapshot.value;
    return snapshot.kind === 'ready' ? <HiddenSection store={store} data={snapshot.data} /> : null;
  };
  const view = render(<Shell />);
  const removeFromState = (host: string, selector: string): void => {
    const rows = (current.hidden ?? []).map((s) => (s.host === host ? { ...s, selectors: s.selectors.filter((x) => x !== selector) } : s)).filter((s) => s.selectors.length > 0);
    current = dashboard({ hidden: rows });
  };
  return { request, store, view, removeFromState };
}

describe('Hidden items route (P2-22)', () => {
  test('a nav section after Sites, reached by #hidden', () => {
    expect(SECTIONS.indexOf('hidden')).toBe(SECTIONS.indexOf('sites') + 1);
    expect(SECTION_TITLES.hidden).toBe('Hidden items');
    expect(sectionOf('#hidden')).toBe('hidden');
  });
});

describe('Hidden items section (P2-22)', () => {
  test('grouped by site: a heading per site, a list of what was hidden, one labelled Remove each; no axe violations', async () => {
    const { view } = await mount(TWO_SITES);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['news.example', 'shop.example']);
    const news = screen.getByRole('region', { name: 'news.example' });
    expect(within(news).getAllByRole('listitem').map((li) => li.querySelector('code')?.textContent)).toEqual(['#ad', '.promo']);
    expect(within(news).getByRole('button', { name: 'Remove #ad on news.example' })).toBeTruthy();
    expect(screen.getByText('3 things hidden on 2 sites.')).toBeTruthy();
    expect(screen.getByText(/What you hid with "Hide something"/)).toBeTruthy();
    expect(await axeViolations(view.container)).toEqual([]);
  });

  test('selector text is shown as text, never parsed as markup', async () => {
    await mount([{ host: 'x.example', selectors: ['a[title="&amp;"]'] }]);
    expect(screen.getByText('a[title="&amp;"]').tagName).toBe('CODE');
  });

  test('Remove sends c/removeUserFilter, says so, and moves focus to the next Remove button', async () => {
    const { request, view, removeFromState, store } = await mount(TWO_SITES);
    const button = screen.getByRole('button', { name: 'Remove #ad on news.example' });
    button.focus();
    removeFromState('news.example', '#ad');
    fireEvent.click(button);
    await waitFor(() => {
      expect(store.status.value).toBe('Removed. It shows again on that site. If a page still hides it, reload that page.');
    });
    expect(request).toHaveBeenCalledWith('c/removeUserFilter', { hostname: 'news.example', selector: '#ad' }, expect.anything());
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove .promo on news.example');
    });
    expect(await axeViolations(view.container)).toEqual([]);
  });

  test('removing the last item moves focus to the list heading and shows the empty text', async () => {
    const { removeFromState, store } = await mount([{ host: 'a.example', selectors: ['#x'] }]);
    removeFromState('a.example', '#x');
    fireEvent.click(screen.getByRole('button', { name: 'Remove #x on a.example' }));
    await waitFor(() => {
      expect(store.status.value).toContain('Removed.');
    });
    expect(screen.getByRole('heading', { name: 'Nothing hidden yet' })).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('hidden-heading');
    });
    expect(document.activeElement?.textContent).toBe('Nothing hidden yet');
  });

  test('a refused remove keeps the item and says it failed', async () => {
    const { store } = await mount(TWO_SITES, { 'c/removeUserFilter': { ok: false, error: { code: 'refused', reason: 'internal' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove #chat on shop.example' }));
    await waitFor(() => {
      expect(store.status.value).toBe('Could not save the change. Try again.');
    });
    expect(screen.getByRole('button', { name: 'Remove #chat on shop.example' })).toBeTruthy();
  });

  test('empty list (D-97/C14): a card with its heading and how to hide something, no intro; unreadable store: an error, no list', async () => {
    const { view } = await mount([]);
    expect(screen.getByRole('heading', { level: 2, name: 'Nothing hidden yet' })).toBeTruthy();
    expect(screen.getByText('Open the toolbar panel on a page and choose "Hide something".')).toBeTruthy();
    expect(screen.queryByText(/What you hid with/)).toBeNull();
    expect(await axeViolations(view.container)).toEqual([]);
    cleanup();
    await mount(null);
    expect(screen.getByText(/could not be read/)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});
