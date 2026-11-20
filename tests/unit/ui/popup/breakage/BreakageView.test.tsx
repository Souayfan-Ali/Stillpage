// @vitest-environment jsdom
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createWorker } from '../../../../../src/background/worker.js';
import type { RulesetId } from '../../../../../src/core/ids.js';
import { createClient } from '../../../../../src/features/popup/client.js';
import { PopupApp } from '../../../../../src/features/popup/PopupApp.js';
import { createPopupStore } from '../../../../../src/features/popup/store.js';
import { stepOf } from '../../../../../src/features/popup/breakage/steps.js';
import { createFakeBrowser } from '../../../platform/fakes/browser.js';
import { NOW, testCatalog } from '../../../core/reconcile/fixtures.js';
import { axeViolations } from '../../axe.js';

afterEach(cleanup);
// The first open pays for the chunk's cold `import()`, which can exceed the 1 s default under machine load.
configure({ asyncUtilTimeout: 5_000 });

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const POPUP = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/popup.html?tabId=7`, origin: `chrome-extension://${RUNTIME_ID}` };

interface ReportOptions {
  readonly tracker?: string | null;
  readonly incognito?: boolean;
}

async function mount(url = 'https://news.example.com/a', report: ReportOptions = {}) {
  const b = createFakeBrowser({ rulesets: [{ id: 'ubo' as RulesetId, enabled: true, regexCount: 0 }], catalog: testCatalog(), now: () => NOW });
  b.setTab(7, url);
  const { handlers } = createWorker(b.ports, RUNTIME_ID);
  await handlers.message({ v: 1, type: 'c/reconcile', id: 'r', payload: {} }, POPUP);
  const client = createClient({ send: (envelope) => handlers.message(envelope, POPUP) });
  let items: Record<string, unknown> = {};
  const session = {
    get: (k: string) => Promise.resolve(items[k]),
    set: (k: string, v: unknown) => {
      items = { ...items, [k]: structuredClone(v) };
      return Promise.resolve();
    },
    remove: (k: string) => {
      items = Object.fromEntries(Object.entries(items).filter(([key]) => key !== k));
      return Promise.resolve();
    },
  };
  const reloadTab = vi.fn(() => Promise.resolve());
  const store = createPopupStore({ client, page: { activeTabId: () => Promise.resolve(7), requestOrigins: () => Promise.resolve(true), reloadTab }, tabIdFromUrl: 7 });
  const copyText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  const openTab = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
  const reportDeps = { client, copyText, openTab, version: '1.0.317.600', chromeMajor: 155, incognito: report.incognito ?? false, tracker: report.tracker ?? null };
  const view = render(<PopupApp store={store} now={() => NOW} breakage={{ client, session, reloadTab, now: () => NOW, report: reportDeps }} />);
  await store.load();
  return { ...view, reloadTab, copyText, openTab };
}

describe('breakage flow view (P2-14)', () => {
  test('entry opens the flow (own chunk), focus on its heading, complaints are buttons; Back returns focus; axe clean', async () => {
    const { container } = await mount();
    const entry = await screen.findByRole('button', { name: 'Something wrong with this page?' });
    entry.focus();
    fireEvent.click(entry);
    const heading = await screen.findByRole('heading', { name: 'Fix this page' });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(screen.getByRole('group', { name: 'What is wrong?' })).toBeTruthy();
    await screen.findByRole('button', { name: 'The page looks broken or will not work' });
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toContain('Something wrong with this page?');
    });
  });

  test('page broken: step 1 of 3 offers Light; after it, Fixed / Still broken; still broken offers Off; then report', async () => {
    const { container, reloadTab } = await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Something wrong with this page?' }));
    fireEvent.click(await screen.findByRole('button', { name: 'The page looks broken or will not work' }));
    expect((await screen.findByRole('heading', { level: 3 })).textContent).toBe('Step 1 of 3 — The page looks broken or will not work');
    expect(screen.getByText('Keeps blocking requests, stops changing the page.')).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Try it and reload' }));
    await screen.findByText('After the reload:');
    expect(reloadTab).toHaveBeenCalledWith(7);
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Still broken' }));
    expect((await screen.findByRole('heading', { name: /Turn off on this site/ })).tagName).toBe('H4');
    expect(screen.getByRole('heading', { level: 3 }).textContent).toContain('Step 2 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Report this (you review everything first)' }));
    await screen.findByText('Nothing here fixed it. You can report the problem.');
    expect(screen.getByRole('heading', { level: 3 }).textContent).toContain('Step 3 of 3');
  });

  test('Fixed ends the flow and says what stays on', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Something wrong with this page?' }));
    fireEvent.click(await screen.findByRole('button', { name: 'The site says I use an ad blocker' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try it and reload' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fixed' }));
    await screen.findByText('Glad it works now. “Try Thorough here” stays on for this site.');
  });

  test('no entry on a page without a host', async () => {
    await mount('chrome://settings/');
    await screen.findByText('Chrome does not allow extensions on this page');
    expect(screen.queryByRole('button', { name: 'Something wrong with this page?' })).toBeNull();
  });
});

async function toReport(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Something wrong with this page?' }));
  fireEvent.click(await screen.findByRole('button', { name: 'The page looks broken or will not work' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Try it and reload' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Still broken' }));
  await screen.findByRole('heading', { name: 'Turn off on this site' });
  fireEvent.click(screen.getByRole('button', { name: 'Report this (you review everything first)' }));
}

describe('report step (P2-15)', () => {
  test('editable preview with the hostname only; Copy report while the tracker is the placeholder; axe clean', async () => {
    const { container, copyText, openTab } = await mount('https://news.example.com/private/path?token=secret#frag');
    await toReport();
    const box = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Report (you can edit it before sending)' });
    await vi.waitFor(() => {
      expect(box.value).toContain('Site: news.example.com (path and query are never included)');
    });
    expect(box.value).toContain('Problem: the page looks broken · tried: Light mode (still broken)');
    expect(box.value).toContain('Version: 1.0.317.600 · Chrome 155 · level: Standard · packs: ads, trackers, popups');
    expect(box.value).not.toMatch(/private|token|secret|frag|https?:/);
    expect(box.maxLength).toBe(4_000);
    expect(screen.queryByRole('button', { name: 'Open a new issue' })).toBeNull();
    expect(screen.getByText(/There is no public issue tracker yet/)).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.input(box, { target: { value: `${box.value}\nIt breaks on checkout.` } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy report' }));
    await vi.waitFor(() => {
      expect(screen.getByText('Report copied.')).toBeTruthy();
    });
    expect(copyText.mock.calls[0]?.[0]).toMatch(/It breaks on checkout\.$/);
    expect(openTab).not.toHaveBeenCalled();
  });

  test('with a tracker: opens a prefilled new issue in a new tab; a private window is named above the preview', async () => {
    const { openTab } = await mount('https://news.example.com/a?b=1', { tracker: 'https://github.com/owner/repo', incognito: true });
    await toReport();
    expect(await screen.findByText('This is a private window. The report names this site.')).toBeTruthy();
    expect(
      screen.getByText(
        '"Open a new issue" opens GitHub in a new tab with the text in the box and a title that names the problem and the site, never the page address. It is published only when you submit it there.',
      ),
    ).toBeTruthy();
    const box = await screen.findByRole<HTMLTextAreaElement>('textbox');
    await vi.waitFor(() => {
      expect(box.value).toContain('Site: news.example.com');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open a new issue' }));
    await vi.waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(1);
    });
    const url = new URL(openTab.mock.calls[0]?.[0] ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/owner/repo/issues/new');
    expect(url.searchParams.get('template')).toBe('breakage.yml');
    expect(url.searchParams.get('title')).toBe('The page looks broken: news.example.com');
    expect(url.searchParams.get('report')).toBe(box.value);
    expect(url.searchParams.get('report')).not.toContain('b=1');
    expect(await screen.findByText('A new tab opened on GitHub with the report. Submit it there, or close the tab and nothing is published.')).toBeTruthy();
  });

  test('D-113: the title names the site even when the user deletes it from the box', async () => {
    const { openTab } = await mount('https://news.example.com/a?b=1', { tracker: 'https://github.com/owner/repo' });
    await toReport();
    const box = await screen.findByRole<HTMLTextAreaElement>('textbox');
    await vi.waitFor(() => {
      expect(box.value).toContain('Site: news.example.com');
    });
    fireEvent.input(box, { target: { value: 'It breaks.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open a new issue' }));
    await vi.waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(1);
    });
    const params = new URL(openTab.mock.calls[0]?.[0] ?? '').searchParams;
    expect(params.get('report')).toBe('It breaks.');
    expect(params.get('title')).toMatch(/: news\.example\.com$/);
  });
});

describe('stepOf', () => {
  const base = { v: 1, tabId: 1, host: 'a.example', trial: null, outcomes: [], updatedAt: 0 } as const;
  test.each([
    [{ complaint: 'broken', step: 1, phase: 'offer' }, { n: 1, of: 3 }],
    [{ complaint: 'broken', step: 0, phase: 'offer' }, { n: 1, of: 4 }],
    [{ complaint: 'adThrough', step: 1, phase: 'offer' }, { n: 2, of: 3 }],
    [{ complaint: 'antiAdblock', step: 1, phase: 'report' }, { n: 3, of: 3 }],
  ] as const)('%o → %o', (state, expected) => {
    expect(stepOf({ ...base, ...state } as unknown as Parameters<typeof stepOf>[0])).toEqual(expected);
  });
});
