// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, test } from 'vitest';
import type { Dashboard } from '../../../../src/core/messaging/dashboard.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import type { Settings } from '../../../../src/core/state/types.js';
import { ProtectionSection } from '../../../../src/features/dashboard/sections/ProtectionSection.js';
import { SitesSection } from '../../../../src/features/dashboard/sites/SitesSection.js';
import { createDashboardStore } from '../../../../src/features/dashboard/store.js';
import { axeViolations } from '../../ui/axe.js';
import { dashboard, scripted } from './fixtures.js';

afterEach(cleanup);

async function storeFor(data: Dashboard) {
  const request = scripted(() => data);
  const store = createDashboardStore({ request, requestOrigins: () => Promise.resolve(true) });
  await store.load();
  return { request, store };
}

const withSites: Settings = {
  ...createDefaultSettings(),
  siteLevels: { 'a.example': 'light' } as Settings['siteLevels'],
  popups: { mode: 'smart', sites: { 'pay.example': 'allow' } as Settings['popups']['sites'], notice: true },
};

describe('pop-up controls in the dashboard (P2-60, dashboard part)', () => {
  test('mode: a native radio group; a choice is sent; no axe violations', async () => {
    const data = dashboard({ settings: withSites });
    const { request, store } = await storeFor(data);
    const { container } = render(<ProtectionSection store={store} data={data} />);
    expect(screen.getByLabelText<HTMLInputElement>('Smart').checked).toBe(true);
    expect(screen.getByText(/Smart cannot catch/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Strict'));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('c/setPopupMode', { mode: 'strict' }, expect.anything());
    });
    expect(await axeViolations(container)).toEqual([]);
  });

  test('P2-60b: "Tell me when a pop-up is blocked" shows the stored choice and sends c/setPopupNotice; axe clean', async () => {
    const data = dashboard({ settings: withSites });
    const { request, store } = await storeFor(data);
    const { container } = render(<ProtectionSection store={store} data={data} />);
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Tell me when a pop-up is blocked' });
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('c/setPopupNotice', { enabled: false }, expect.anything());
    });
    expect(await axeViolations(container)).toEqual([]);
  });

  test('while the build has no guard the note says the choice is saved but not active; with it, no note', async () => {
    const off = dashboard({ popupGuard: false });
    const first = await storeFor(off);
    render(<ProtectionSection store={first.store} data={off} />);
    expect(screen.getByText(/not active in this version yet/)).toBeTruthy();
    cleanup();
    const on = dashboard({ popupGuard: true });
    const second = await storeFor(on);
    render(<ProtectionSection store={second.store} data={on} />);
    expect(screen.queryByText(/not active in this version yet/)).toBeNull();
  });

  test('Sites column: a per-site select sends c/setSitePopupPolicy; Default is inherit', async () => {
    const data = dashboard({ settings: withSites });
    const { request, store } = await storeFor(data);
    const { container } = render(<SitesSection store={store} data={data} now={() => 0} />);
    expect(screen.getByLabelText<HTMLSelectElement>('Pop-ups on pay.example').value).toBe('allow');
    expect(screen.getByText(/only "Allowed" has an effect/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Pop-ups on a.example'), { target: { value: 'strict' } });
    fireEvent.change(screen.getByLabelText('Pop-ups on pay.example'), { target: { value: 'inherit' } });
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('c/setSitePopupPolicy', { hostname: 'pay.example', policy: 'inherit' }, expect.anything());
    });
    expect(request).toHaveBeenCalledWith('c/setSitePopupPolicy', { hostname: 'a.example', policy: 'strict' }, expect.anything());
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('pop-up limits line (D-96)', () => {
  test.each([
    ['smart', true],
    ['strict', false],
    ['off', false],
  ] as const)('mode %s: the "Smart cannot catch" line shown: %s', async (mode, shown) => {
    const data = dashboard({ settings: { ...withSites, popups: { ...withSites.popups, mode } } });
    const { store } = await storeFor(data);
    render(<ProtectionSection store={store} data={data} />);
    expect(screen.queryByText(/Smart cannot catch/) !== null).toBe(shown);
  });
});
