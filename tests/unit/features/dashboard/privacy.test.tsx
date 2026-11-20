// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, test } from 'vitest';
import type { Dashboard } from '../../../../src/core/messaging/dashboard.js';
import { PERMISSION_ROWS } from '../../../../src/features/dashboard/privacy/permissions.js';
import { PrivacySection } from '../../../../src/features/dashboard/privacy/PrivacySection.js';
import { createDashboardStore } from '../../../../src/features/dashboard/store.js';
import { axeViolations } from '../../ui/axe.js';
import { dashboard, scripted } from './fixtures.js';

afterEach(cleanup);

async function mount(data: Dashboard) {
  const request = scripted(() => data);
  const store = createDashboardStore({ request, requestOrigins: () => Promise.resolve(true) });
  await store.load();
  const view = render(<PrivacySection store={store} data={data} />);
  return { request, view };
}

describe('Privacy section (P2-36)', () => {
  test('choices: GPC, tracking parameters and the badge send their commands', async () => {
    const { request } = await mount(dashboard());
    fireEvent.click(screen.getByLabelText(/do not sell or share/));
    fireEvent.click(screen.getByLabelText('Tracking parameters'));
    fireEvent.click(screen.getByLabelText(/number of blocked requests/));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('c/setShowBadge', { enabled: false }, expect.anything());
    });
    expect(request).toHaveBeenCalledWith('c/setGpc', { enabled: true }, expect.anything());
    expect(request).toHaveBeenCalledWith('c/setPack', { pack: 'params', enabled: true }, expect.anything());
  });

  test('without all-sites access GPC says it has no effect yet', async () => {
    await mount(dashboard({ allSites: false }));
    expect(screen.getByText(/until then it has no effect/)).toBeTruthy();
  });

  test('the privacy page: no requests, stored data, every permission row, the ones never asked for; no axe violations', async () => {
    const { view } = await mount(dashboard());
    expect(screen.getByText(/makes no network requests/)).toBeTruthy();
    expect(screen.getByText(/The one exception is yours to make: "Open a new issue" in a problem report opens github\.com in a browser tab with the report you reviewed\.$/)).toBeTruthy();
    const tables = screen.getAllByRole('table');
    expect(tables).toHaveLength(2);
    expect(within(tables[0] ?? document.body).getAllByRole('rowheader')).toHaveLength(PERMISSION_ROWS.length);
    expect(tables[1]?.textContent).toContain('webRequest');
    expect(screen.getByText('Our pledge (v0, draft)')).toBeTruthy();
    expect(screen.getByText(/not legally reviewed/i)).toBeTruthy();
    // D-98: choices, network requests, what is stored and the permissions stay open; the rest is collapsed.
    const summaries = [...view.container.querySelectorAll('[aria-labelledby="privacy-page-heading"] details > summary')].map((s) => s.textContent);
    expect(summaries).toEqual([expect.stringMatching(/not ask for/), 'Our pledge (v0, draft)', expect.stringMatching(/Check a build/)]);
    for (const open of ['dprivacy-requests', 'dprivacy-stored', 'dprivacy-permissions']) expect(view.container.querySelector(`#${open}`)?.closest('details')).toBeNull();
    expect(tables[0]?.closest('details')).toBeNull();
    expect(tables[1]?.closest('details')).not.toBeNull();
    expect(await axeViolations(view.container)).toEqual([]);
  });

  test('a build without the GPC or params pack shows neither', async () => {
    await mount(dashboard({ packs: dashboard().packs.filter((p) => p.id !== 'gpc' && p.id !== 'params') }));
    expect(screen.queryByLabelText(/do not sell or share/)).toBeNull();
    expect(screen.queryByLabelText('Tracking parameters')).toBeNull();
  });
});
