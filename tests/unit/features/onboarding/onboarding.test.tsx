// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Dashboard } from '../../../../src/core/messaging/dashboard.js';
import { OnboardingApp } from '../../../../src/features/onboarding/OnboardingApp.js';
import { createOnboardingStore } from '../../../../src/features/onboarding/store.js';
import { axeViolations } from '../../ui/axe.js';
import { dashboard, scripted } from '../dashboard/fixtures.js';

afterEach(cleanup);

function setup(data: Dashboard | null = dashboard(), answers: Parameters<typeof scripted>[1] = {}, language = 'de-DE') {
  const request = scripted(() => data, answers);
  const requestOrigins = vi.fn(() => Promise.resolve(true));
  const store = createOnboardingStore({ request, requestOrigins, language });
  const view = render(<OnboardingApp store={store} language={language} privacyUrl="/dashboard.html#privacy" dashboardUrl="/dashboard.html" />);
  return { store, request, requestOrigins, view };
}

const sent = (request: ReturnType<typeof scripted>, type: string): unknown[] =>
  request.mock.calls.filter((c: unknown[]) => c[0] === type).map((c: unknown[]) => c[1]);

describe('onboarding (P2-33)', () => {
  test('step 1: protected, site access stated, link to the privacy page; no axe violations', async () => {
    const { store, view } = setup();
    await store.load();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('You are protected.');
    expect(screen.getByText('Site access: allowed on all sites')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'How we can prove it' }).getAttribute('href')).toBe('/dashboard.html#privacy');
    expect(screen.getByRole('listitem', { name: 'Step 1 of 3: Protection' }).getAttribute('aria-current')).toBe('step');
    expect(await axeViolations(view.container)).toEqual([]);
  });

  test('stepper (D18): visible names only, "Step N of 3: name" as each step\'s label (label in name)', async () => {
    const { store } = setup();
    await store.load();
    const steps = screen.getAllByRole('listitem').slice(0, 3);
    expect(steps.map((li) => li.textContent)).toEqual(['Protection', 'Extras', 'Tools']);
    expect(steps.map((li) => li.getAttribute('aria-label'))).toEqual(['Step 1 of 3: Protection', 'Step 2 of 3: Extras', 'Step 3 of 3: Tools']);
    for (const li of steps) expect(li.getAttribute('aria-label')).toContain(li.textContent);
  });

  test('status (D20): "Saved." and the access answer are cleared when the step changes', async () => {
    const { store } = setup(dashboard({ allSites: false }));
    await store.load();
    fireEvent.click(screen.getByRole('button', { name: 'Allow on all sites' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Site access allowed.');
    });
    await store.next();
    await screen.findByRole('heading', { level: 1, name: 'Choose extras' });
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.getByText('Optional. All off until you turn them on; change them any time in the dashboard.')).toBeTruthy();
    await store.next();
    await screen.findByRole('heading', { level: 1, name: 'Three things to know' });
    expect(screen.getByRole('status').textContent).toBe('');
    expect(store.status.value).toBe('');
    // D-106: step 3 names both ways in, the right-click entry first.
    expect(screen.getByText('Right-click what you want gone and choose "Hide this…", or open the toolbar panel and choose "Hide something".')).toBeTruthy();
  });

  test('step 1 without site access: "Allow on all sites" asks Chrome, "Keep Light mode" moves on', async () => {
    const { store, requestOrigins } = setup(dashboard({ allSites: false }));
    await store.load();
    fireEvent.click(screen.getByRole('button', { name: 'Allow on all sites' }));
    expect(requestOrigins).toHaveBeenCalledWith(['<all_urls>']);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Site access allowed.');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Keep Light mode' }));
    await screen.findByRole('heading', { level: 1, name: 'Choose extras' });
  });

  test('step 2: everything off except the suggested language; nothing sent until Next', async () => {
    const { store, request } = setup();
    await store.load();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { level: 1, name: 'Choose extras' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    expect(screen.getByLabelText<HTMLInputElement>('Filters for your language: German').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Hide cookie banners').checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Hide cookie banners'));
    expect(sent(request, 'c/setPack')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { level: 1, name: 'Three things to know' });
    expect(sent(request, 'c/setPack')).toEqual([
      { pack: 'cookies', enabled: true },
      { pack: 'reg-de', enabled: true },
    ]);
  });

  test('step 2: a refused pack is shown beside it and the page stays on step 2', async () => {
    const refusal = { ok: false, error: { code: 'refused', reason: 'no-capacity', detail: { reason: 'regex-pool', needed: 60, available: 3 } } } as const;
    const { store } = setup(dashboard(), { 'c/setPack': refusal });
    await store.load();
    await store.next();
    await store.next();
    expect((await screen.findByRole('alert')).textContent).toContain('cannot be on together');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Choose extras');
    expect(screen.getByRole('status').textContent).toContain('could not be turned on');
  });

  test('step 3 shows the tools; Finish completes; Back goes back', async () => {
    const { store, request, view } = setup(dashboard(), {}, 'fr');
    await store.load();
    await store.next();
    expect(screen.queryByText(/your language/)).toBeNull();
    await store.next();
    await screen.findByRole('heading', { level: 1, name: 'Three things to know' });
    expect(await axeViolations(view.container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { level: 1, name: 'Choose extras' });
    await store.next();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await screen.findByRole('heading', { level: 1, name: 'All set.' });
    expect(sent(request, 'c/completeOnboarding')).toEqual([{}]);
    expect(sent(request, 'c/setPack')).toEqual([]);
  });

  test('"Skip setup" completes from step 1 and applies nothing', async () => {
    const { store, request } = setup();
    await store.load();
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
    await screen.findByRole('heading', { level: 1, name: 'All set.' });
    expect(sent(request, 'c/setPack')).toEqual([]);
    expect(sent(request, 'c/completeOnboarding')).toEqual([{}]);
  });

  test('no answer from the worker: a calm message; Next still moves through the steps', async () => {
    const { store } = setup(null);
    await store.load();
    expect(screen.getByText(/Protection is on with safe defaults/)).toBeTruthy();
    await store.next();
    await store.next();
    expect(store.step.value).toBe(3);
  });

  test('GPC goes through c/setGpc', async () => {
    const { store, request } = setup();
    await store.load();
    await store.next();
    store.choose('gpc', true);
    store.choose('language', false);
    await store.next();
    expect(sent(request, 'c/setGpc')).toEqual([{ enabled: true }]);
  });
});
