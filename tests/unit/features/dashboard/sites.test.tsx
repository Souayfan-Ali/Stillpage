// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, test } from 'vitest';
import type { JSX } from 'preact';
import type { Dashboard } from '../../../../src/core/messaging/dashboard.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import type { Settings } from '../../../../src/core/state/types.js';
import { checkNewSite, siteRows } from '../../../../src/features/dashboard/sites/rows.js';
import { SitesSection } from '../../../../src/features/dashboard/sites/SitesSection.js';
import type { Request } from '../../../../src/features/dashboard/client.js';
import { createDashboardStore, type DashboardStore } from '../../../../src/features/dashboard/store.js';
import { axeViolations } from '../../ui/axe.js';
import { dashboard, scripted } from './fixtures.js';

afterEach(cleanup);

const NOW = 1_763_100_000_000;

const withSites = (): Settings => ({
  ...createDefaultSettings(),
  siteLevels: { 'b.example': 'off', 'a.example': 'thorough' } as Settings['siteLevels'],
  pauses: { 'c.example': { until: NOW + 30 * 60_000 }, 'old.example': { until: NOW - 1 } } as Settings['pauses'],
  popups: { mode: 'off', sites: { 'pay.example': 'allow' } as Settings['popups']['sites'], notice: true },
});

const manySites = (n: number): Settings => ({
  ...createDefaultSettings(),
  siteLevels: Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${String(i)}.example`, 'light'])),
});

async function mount(data: Dashboard) {
  const request = scripted(() => data);
  const store = createDashboardStore({ request, requestOrigins: () => Promise.resolve(true) });
  await store.load();
  const view = render(<SitesSection store={store} data={data} now={() => NOW} />);
  return { request, view, store };
}

/** Renders the section from the store's snapshot, as the dashboard does, so a command re-renders it. */
function FromStore({ store }: { readonly store: DashboardStore }): JSX.Element | null {
  const snapshot = store.snapshot.value;
  return snapshot.kind === 'ready' ? <SitesSection store={store} data={snapshot.data} now={() => NOW} /> : null;
}

describe('site rows (P2-35)', () => {
  test('levels, active pauses and pop-up policies, sorted; expired pauses left out', () => {
    expect(siteRows(withSites(), NOW).map((r) => [r.host, r.level, r.pausedUntil, r.popupPolicy])).toEqual([
      ['a.example', 'thorough', null, null],
      ['b.example', 'off', null, null],
      ['c.example', null, NOW + 30 * 60_000, null],
      ['pay.example', null, null, 'allow'],
    ]);
  });

  test('search filters by part of the name, ignoring case and spaces', () => {
    expect(siteRows(withSites(), NOW, '  PAY ').map((r) => r.host)).toEqual(['pay.example']);
  });

  test('adding: the worker hostname rule and the per-level cap', () => {
    expect(checkNewSite(createDefaultSettings(), ' News.Example.COM ', 'off')).toEqual({ ok: true, host: 'news.example.com' });
    expect(checkNewSite(createDefaultSettings(), 'https://x.example/path', 'off')).toEqual({ ok: false, problem: 'invalid' });
    const full = { ...createDefaultSettings(), siteLevels: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`s${String(i)}.example`, 'off'])) } as Settings;
    expect(checkNewSite(full, 'new.example', 'off')).toEqual({ ok: false, problem: 'full' });
    expect(checkNewSite(full, 'new.example', 'light')).toMatchObject({ ok: true });
    expect(checkNewSite(full, 's1.example', 'off')).toMatchObject({ ok: true });
  });
});

describe('Sites section (P2-35)', () => {
  test('table with a caption, row headers and labelled controls; no axe violations', async () => {
    const { view } = await mount(dashboard({ settings: withSites() }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['a.example', 'b.example', 'c.example', 'pay.example']);
    expect(screen.getByLabelText<HTMLSelectElement>('Level for b.example').value).toBe('off');
    expect(screen.getByText(/Paused until/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove a.example' })).toBeTruthy();
    expect(await axeViolations(view.container)).toEqual([]);
  });

  test('empty (D-97): the new empty text, no list heading, no search, no table', async () => {
    const { view } = await mount(dashboard());
    expect(screen.getByText('No sites yet. Set a level, a pause or a pop-up choice in the toolbar panel and the site appears here, or add one above.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your sites' })).toBeNull();
    expect(screen.queryByLabelText('Search sites')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(await axeViolations(view.container)).toEqual([]);
  });

  test('search only from 8 sites (D-97)', async () => {
    await mount(dashboard({ settings: withSites() }));
    expect(screen.getByRole('heading', { name: 'Your sites' })).toBeTruthy();
    expect(screen.queryByLabelText('Search sites')).toBeNull();
    cleanup();
    await mount(dashboard({ settings: manySites(8) }));
    expect(screen.getByLabelText('Search sites')).toBeTruthy();
  });

  test('D-120: the search text is cleared when the box disappears below 8 sites', async () => {
    const { view, store } = await mount(dashboard({ settings: manySites(8) }));
    fireEvent.input(screen.getByLabelText('Search sites'), { target: { value: 's1' } });
    expect(screen.getAllByRole('rowheader')).toHaveLength(1);
    view.rerender(<SitesSection store={store} data={dashboard({ settings: manySites(7) })} now={() => NOW} />);
    expect(screen.queryByLabelText('Search sites')).toBeNull();
    await waitFor(() => {
      expect(screen.getAllByRole('rowheader')).toHaveLength(7);
    });
    view.rerender(<SitesSection store={store} data={dashboard({ settings: manySites(8) })} now={() => NOW} />);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Search sites').value).toBe('');
      expect(screen.getAllByRole('rowheader')).toHaveLength(8);
    });
  });

  test('D-97: after the last site is removed, focus lands on the empty text', async () => {
    let data = dashboard({ settings: { ...createDefaultSettings(), siteLevels: { 'a.example': 'off' } as Settings['siteLevels'] } });
    const answer = scripted(() => data);
    const request: Request = (type, payload, schema) => {
      if (type === 'c/forgetSites') data = dashboard();
      return answer(type, payload, schema);
    };
    const store = createDashboardStore({ request, requestOrigins: () => Promise.resolve(true) });
    await store.load();
    render(<FromStore store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.example' }));
    const empty = await screen.findByText(/^No sites yet\./);
    await waitFor(() => {
      expect(document.activeElement).toBe(empty);
    });
  });

  test('no-match state', async () => {
    await mount(dashboard({ settings: manySites(9) }));
    fireEvent.input(screen.getByLabelText('Search sites'), { target: { value: 'zzz' } });
    expect(screen.getByText('No site matches your search.')).toBeTruthy();
  });

  test('changing a level, resuming and removing one row send the commands', async () => {
    const { request } = await mount(dashboard({ settings: withSites() }));
    fireEvent.change(screen.getByLabelText('Level for a.example'), { target: { value: 'light' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resume c.example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove pay.example' }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('c/forgetSites', { hostnames: ['pay.example'] }, expect.anything());
    });
    expect(request).toHaveBeenCalledWith('c/setSiteLevel', { hostname: 'a.example', level: 'light' }, expect.anything());
    expect(request).toHaveBeenCalledWith('c/setSiteLevel', { hostname: 'c.example', level: 'inherit' }, expect.anything());
  });

  test('bulk remove sends the selected hosts in one command', async () => {
    const { request } = await mount(dashboard({ settings: withSites() }));
    expect(screen.queryByRole('button', { name: /selected/ })).toBeNull();
    fireEvent.click(screen.getByLabelText('Select a.example'));
    fireEvent.click(screen.getByLabelText('Select b.example'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 2 selected sites' }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('c/forgetSites', { hostnames: ['a.example', 'b.example'] }, expect.anything());
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /selected/ })).toBeNull();
    });
  });

  test('add: an invalid address shows an error tied to the field and sends nothing', async () => {
    const { request } = await mount(dashboard());
    const field = screen.getByLabelText('Site address');
    fireEvent.input(field, { target: { value: 'not a host' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add site' }));
    const alert = screen.getByRole('alert');
    expect(field.getAttribute('aria-describedby')).toContain(alert.id);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(request).not.toHaveBeenCalledWith('c/setSiteLevel', expect.anything(), expect.anything());
  });

  test('add: a valid address with a level is sent; Enter submits too', async () => {
    const { request } = await mount(dashboard());
    fireEvent.input(screen.getByLabelText('Site address'), { target: { value: 'Shop.Example' } });
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'light' } });
    const form = screen.getByLabelText('Site address').closest('form');
    if (form === null) throw new Error('no form');
    fireEvent.submit(form);
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('c/setSiteLevel', { hostname: 'shop.example', level: 'light' }, expect.anything());
    });
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Site address').value).toBe('');
    });
  });
});
