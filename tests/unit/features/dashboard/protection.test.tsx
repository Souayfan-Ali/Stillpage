// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Dashboard } from '../../../../src/core/messaging/dashboard.js';
import { DashboardApp } from '../../../../src/features/dashboard/DashboardApp.js';
import { sectionOf } from '../../../../src/features/dashboard/route.js';
import { createRestoreStore } from '../../../../src/features/dashboard/backup/backupStore.js';
import { renderSection } from '../../../../src/features/dashboard/sections.js';
import { createDashboardStore } from '../../../../src/features/dashboard/store.js';
import { packRefusalText } from '../../../../src/features/dashboard/strings.js';
import { axeViolations } from '../../ui/axe.js';
import { dashboard, scripted } from './fixtures.js';

afterEach(cleanup);

function setup(initial: Dashboard | null, answers: Parameters<typeof scripted>[1] = {}) {
  let current = initial;
  const request = scripted(() => current, answers);
  const requestOrigins = vi.fn(() => Promise.resolve(true));
  const store = createDashboardStore({ request, requestOrigins });
  const mount = async (hash = '#protection', navigated = false) => {
    const view = render(<DashboardApp store={store} section={sectionOf(hash)} navigated={navigated} renderSection={(s, d) => renderSection({ store, restore: createRestoreStore(request, () => store.load(), () => []), version: '0.0.1', now: () => 0 }, s, d)} />);
    await store.load();
    return view;
  };
  return { store, request, requestOrigins, mount, set: (d: Dashboard) => (current = d) };
}

describe('dashboard shell (P2-34)', () => {
  test('shows its shell before the answer, then the section; no axe violations', async () => {
    const { mount } = setup(dashboard());
    const { container } = await mount();
    expect(screen.getByRole('navigation', { name: 'Dashboard sections' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Protection' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Protection');
    expect(document.title).toBe('Protection · Glassmere');
    expect(await axeViolations(container)).toEqual([]);
  });

  test('setup link: "Finish setup" until onboarding is done, then "Run setup again"', async () => {
    const { mount, set, store } = setup(dashboard());
    await mount();
    expect(screen.getByRole('link', { name: 'Finish setup' }).getAttribute('href')).toBe('/onboarding.html');
    set(dashboard({ settings: { ...dashboard().settings, onboarding: { completedAt: 5 } } }));
    await store.load();
    await screen.findByRole('link', { name: 'Run setup again' });
  });

  test('an unknown hash is Protection', () => {
    expect(sectionOf('')).toBe('protection');
    expect(sectionOf('#nope')).toBe('protection');
    expect(sectionOf('#protection')).toBe('protection');
  });

  test('after navigation focus goes to the section heading', async () => {
    const { mount } = setup(dashboard());
    await mount('#protection', true);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  test('no answer: a plain error, no crash', async () => {
    const { mount } = setup(null);
    await mount();
    expect(screen.getByText(/Could not read your settings/)).toBeTruthy();
  });

  test('notices: reset with "Restore a backup", failed last run, no site access with its button', async () => {
    const { mount, requestOrigins } = setup(dashboard({ settingsReset: true, lastRun: 'failed', allSites: false }));
    const { container } = await mount();
    expect(screen.getByRole('link', { name: 'Restore a backup' }).getAttribute('href')).toBe('#backup');
    expect(screen.getByText(/could not be applied/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow on all sites' }));
    expect(requestOrigins).toHaveBeenCalledWith(['<all_urls>']);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Site access allowed.');
    });
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('Protection section (P2-34)', () => {
  test('default level is a native radio group; a choice is sent', async () => {
    const { mount, request } = setup(dashboard());
    await mount();
    const group = screen.getByRole('group', { name: 'Default level' });
    expect(within(group).getByLabelText<HTMLInputElement>('Standard').checked).toBe(true);
    fireEvent.click(within(group).getByLabelText('Thorough'));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('c/setDefaultLevel', { level: 'thorough' }, expect.anything());
    });
  });

  test('order (D-96): Default level, Pop-ups, Core protection, Extras, Languages, Rule capacity; Pop-ups has the section heading', async () => {
    const { mount } = setup(dashboard());
    const { container } = await mount();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Pop-ups', 'Core protection', 'Extras', 'Languages', 'Rule capacity']);
    const popups = screen.getByRole('region', { name: 'Pop-ups' });
    expect(within(popups).getByRole('group', { name: 'Pop-ups' })).toBeTruthy();
    const level = screen.getByRole('group', { name: 'Default level' });
    expect(level.compareDocumentPosition(popups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  test('core protection and extras lists (D-96); GPC and tracking parameters are not here; pop-up list always on', async () => {
    const { mount } = setup(dashboard());
    await mount();
    const core = within(screen.getByRole('list', { name: 'Core protection' }));
    expect(core.getAllByRole('checkbox').map((c) => c.closest('li')?.dataset['pack'])).toEqual(['ads', 'trackers', 'malware', 'popups']);
    expect(core.getByLabelText<HTMLInputElement>('Known pop-up ad sites').disabled).toBe(true);
    expect(core.getByText('Blocks ads.')).toBeTruthy();
    expect(core.getByText('Blocks trackers that follow you between sites.')).toBeTruthy();
    expect(core.getByText('Blocks sites known for malware and scams.')).toBeTruthy();
    expect(core.getByText('Blocks sites known for pop-up ads, as whole pages.')).toBeTruthy();
    const extras = within(screen.getByRole('list', { name: 'Extras' }));
    expect(extras.getAllByRole('checkbox').map((c) => c.closest('li')?.dataset['pack'])).toEqual(['cookies', 'annoy-overlays']);
    const languages = within(screen.getByRole('list', { name: 'Languages' }));
    expect(languages.getAllByRole('checkbox')).toHaveLength(2);
    expect(languages.getByText('Licence check pending')).toBeTruthy();
  });

  test('details name the upstream lists, licences, homepages and the rule ceiling', async () => {
    const { mount } = setup(dashboard());
    await mount();
    // D-96: the disclosure reads "Details"; its name keeps the pack (label in name: it starts with the visible word).
    const summary = document.querySelector('summary[aria-label="Details: Cookie banners"]');
    expect(summary?.textContent).toBe('Details');
    const cookies = summary?.closest('details');
    expect(cookies?.textContent).toContain('EasyList – Cookie Notices');
    expect(cookies?.textContent).toContain('CC-BY-3.0');
    expect(cookies?.textContent).toContain('Up to 2,000 rules');
    const link = cookies?.querySelector('a');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('a refused pack: inline alert worded from the detail, checkbox back off, Thorough not offered', async () => {
    const refusal = { ok: false, error: { code: 'refused', reason: 'no-capacity', detail: { reason: 'rule-pool', needed: 2400, available: 1100 } } } as const;
    const { mount } = setup(dashboard(), { 'c/setPack': refusal });
    await mount();
    const box = screen.getByLabelText<HTMLInputElement>('Cookie banners');
    fireEvent.click(box);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Not enough room. This pack needs up to 2,400 rules and 1,100 are left. Turn off another pack to make room.');
    expect(box.checked).toBe(false);
    expect(box.getAttribute('aria-describedby')).toContain(alert.id);
  });

  test('no answer in time: says the change may still be applying', async () => {
    const { mount } = setup(dashboard(), { 'c/setDefaultLevel': { ok: false, error: { code: 'no-answer' } } });
    await mount();
    fireEvent.click(screen.getByLabelText('Light'));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('may still be applying');
    });
  });

  test('commands run one at a time in click order', async () => {
    const order: string[] = [];
    let current = dashboard();
    const request = scripted(() => current);
    const slow = vi.fn(async (type: string, payload: unknown, schema: Parameters<typeof request>[2]) => {
      order.push(`start ${type}`);
      const answer = await request(type as 'q/dashboard', payload as object, schema);
      order.push(`end ${type}`);
      return answer;
    });
    const store = createDashboardStore({ request: slow, requestOrigins: () => Promise.resolve(true) });
    current = dashboard();
    await Promise.all([store.setPack('cookies', true), store.run('c/setDefaultLevel', { level: 'light' })]);
    const commands = order.filter((o) => !o.includes('q/dashboard'));
    expect(commands).toEqual(['start c/setPack', 'end c/setPack', 'start c/setDefaultLevel', 'end c/setDefaultLevel']);
  });

  test('refusal wording without rule numbers for other limits', () => {
    expect(packRefusalText({ reason: 'regex-pool', needed: 5, available: 1 })).toBe('This pack cannot be on together with the packs you have on now. Turn off another pack first.');
    expect(packRefusalText(undefined)).toContain('cannot be on together');
  });

  test('enabling cookies offers Thorough; "Use Thorough" sets it, "Not now" hides it', async () => {
    const { mount, request, set } = setup(dashboard(), { 'c/setPack': { ok: true, data: { status: 'applied', offerThorough: true } } });
    await mount();
    set(dashboard({ packs: dashboard().packs.map((p) => (p.id === 'cookies' ? { ...p, enabled: true } : p)) }));
    fireEvent.click(screen.getByLabelText('Cookie banners'));
    await screen.findByRole('button', { name: 'Use Thorough' });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('button', { name: 'Use Thorough' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Cookie banners'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use Thorough' }));
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('c/setDefaultLevel', { level: 'thorough' }, expect.anything());
    });
  });

  test('a pack the last capacity check left out says so', async () => {
    const { mount } = setup(dashboard({ packs: [{ id: 'cookies', default: false, enabled: true, toggleable: true, licence: 'cleared', ceiling: 2400, skipped: 'rule-pool' }] }));
    await mount();
    expect(screen.getByText(/Left out/)).toBeTruthy();
  });

  test('capacity meter: native progress with text; over 30,000 and unknown room', async () => {
    const { mount } = setup(dashboard({ capacity: { guaranteed: 30_000, usedCeiling: 31_500, available: null } }));
    const { container } = await mount();
    const meter = container.querySelector('progress');
    expect(meter?.getAttribute('value')).toBe('30000');
    expect(container.querySelector('#capacity-text')?.textContent).toBe('Using up to 30,000 of the 30,000 rules Chrome guarantees.');
    // D-96: the "more rules" lines sit inside a "Details" disclosure.
    const more = container.querySelector('summary[aria-label="Details: Rule capacity"]')?.closest('details');
    expect(more?.querySelector('summary')?.textContent).toBe('Details');
    expect(more?.textContent).toContain("1,500 more from Chrome's shared pool");
    expect(more?.textContent).toContain('Chrome did not report how much room is left.');
    expect(await axeViolations(container)).toEqual([]);
  });

  test('a failed command says so and keeps the page', async () => {
    const { mount } = setup(dashboard(), { 'c/setDefaultLevel': { ok: false, error: { code: 'refused', reason: 'internal' } } });
    await mount();
    fireEvent.click(screen.getByLabelText('Light'));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Could not save the change. Try again.');
    });
  });
});

describe('Protection capacity line (D-96)', () => {
  test('room left goes inside Details; no shared-pool line under 30,000', async () => {
    const { mount } = setup(dashboard());
    const { container } = await mount();
    expect(container.querySelector('#capacity-text')?.textContent).toBe('Using up to 24,000 of the 30,000 rules Chrome guarantees.');
    const more = container.querySelector('summary[aria-label="Details: Rule capacity"]')?.closest('details');
    expect(more?.textContent).toContain('Chrome reports room for about 280,000 more rules.');
    expect(more?.textContent).not.toContain('shared pool');
  });
});
