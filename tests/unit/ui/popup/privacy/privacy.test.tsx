// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MatchedRules } from '../../../../../src/core/messaging/matched.js';
import type { Client, ClientResult } from '../../../../../src/features/popup/client.js';
import { PopupApp } from '../../../../../src/features/popup/PopupApp.js';
import { createPrivacyStore } from '../../../../../src/features/popup/privacy/privacyStore.js';
import { detailLine, detailParts, splitCount, summaryText } from '../../../../../src/features/popup/privacy/summary.js';
import { createPopupStore } from '../../../../../src/features/popup/store.js';
import type { TabState } from '../../../../../src/core/messaging/tabState.js';
import { NOW, TAB_STATES } from '../../../../fixtures/panel/tabStates.js';
import { axeViolations } from '../../axe.js';

afterEach(cleanup);

const COUNTS: Extract<MatchedRules, { kind: 'counts' }> = {
  kind: 'counts',
  stale: false,
  at: NOW,
  total: 27,
  groups: [
    { category: 'ads', count: 14, buckets: [{ id: 'google', name: 'Google', count: 6 }, { id: 'criteo', name: 'Criteo', count: 3 }, { id: 'other:ads', name: null, count: 5 }] },
    { category: 'tracking', count: 13, buckets: [{ id: 'meta', name: 'Meta', count: 4 }, { id: 'google', name: 'Google', count: 2 }, { id: 'other:tracking', name: null, count: 7 }] },
  ],
  rules: [{ rulesetId: 'ubo', ruleId: 4411 }],
  moreRules: 11,
};

describe('privacy summary text (P2-12)', () => {
  test('card line counts distinct companies and each category', () => {
    expect(detailLine(COUNTS)).toBe('3 companies · 14 ads · 13 trackers');
    expect(detailLine({ ...COUNTS, groups: [{ category: 'malware', count: 1, buckets: [{ id: 'other:malware', name: null, count: 1 }] }] })).toBe('1 malware site');
  });

  test('card tiles (P3-18): companies first, then one per category, in the line\'s order and words', () => {
    expect(detailParts(COUNTS)).toEqual([
      { kind: 'companies', text: '3 companies' },
      { kind: 'ads', text: '14 ads' },
      { kind: 'tracking', text: '13 trackers' },
    ]);
    expect(detailParts({ ...COUNTS, groups: [{ category: 'ads', count: 2, buckets: [{ id: 'other:ads', name: null, count: 2 }] }] })).toEqual([{ kind: 'ads', text: '2 ads' }]);
  });

  test('the headline\'s figure is found in its words for the large number, or not split at all', () => {
    expect(splitCount('27 blocked on this page', 27)).toEqual(['', '27', ' blocked on this page']);
    expect(splitCount('1,234 blocked on this page', 1234)).toEqual(['', '1,234', ' blocked on this page']);
    expect(splitCount('Nothing blocked on this page yet', 0)).toBeNull();
  });

  test('copy summary: host and counts only, with the precise wording', () => {
    expect(summaryText('news.example.com', COUNTS)).toBe(
      [
        'What was blocked on news.example.com',
        'Advertising: 14',
        '  Google: 6',
        '  Criteo: 3',
        '  Other advertising: 5',
        'Tracking: 13',
        '  Meta: 4',
        '  Google: 2',
        '  Other tracking: 7',
        '27 blocked requests matched 12 rules.',
        'Counts cover this page since it loaded.',
      ].join('\n'),
    );
    expect(summaryText(null, { ...COUNTS, total: 1, groups: [], rules: [], moreRules: 1 })).toContain('Nothing has been blocked on this page.\n1 blocked request matched 1 rule.');
  });
});

function setup(state: TabState, answer: ClientResult<MatchedRules>, popupLog?: () => Promise<{ hosts: string[]; blocked: number; codes: 'G11'[] } | null>) {
  const matchedRules = vi.fn(() => Promise.resolve(answer));
  const client = {
    tabState: () => Promise.resolve({ ok: true, data: state }),
    command: () => Promise.resolve({ ok: true, data: null }),
    matchedRules,
  } as unknown as Client;
  const copyText = vi.fn(() => Promise.resolve());
  const privacy = createPrivacyStore({ client, copyText, ...(popupLog === undefined ? {} : { popupLog }) });
  const store = createPopupStore({ client, page: { activeTabId: () => Promise.resolve(1), requestOrigins: () => Promise.resolve(true), reloadTab: () => Promise.resolve() }, tabIdFromUrl: 4 });
  return { store, privacy, matchedRules, copyText };
}

async function mount(deps: ReturnType<typeof setup>) {
  const view = render(<PopupApp store={deps.store} now={() => NOW} privacy={deps.privacy} />);
  await deps.store.load();
  await vi.waitFor(() => {
    expect(deps.matchedRules).toHaveBeenCalled();
  });
  return view;
}

describe('privacy panel in the toolbar panel (P2-12)', () => {
  test('the card shows the totals; asked once per open for the tab; no URL anywhere', async () => {
    const deps = setup(TAB_STATES.normal, { ok: true, data: COUNTS });
    await mount(deps);
    const card = await screen.findByRole('button', { name: /27 blocked on this page/ });
    expect(card.textContent).toContain('3 companies · 14 ads · 13 trackers');
    expect([...card.querySelectorAll('[data-tile]')].map((tile) => tile.getAttribute('data-tile'))).toEqual(['companies', 'ads', 'tracking']);
    expect(card.querySelector('[data-figure]')?.textContent).toBe('27');
    expect(deps.matchedRules).toHaveBeenCalledTimes(1);
    expect(deps.matchedRules).toHaveBeenCalledWith(4);
  });

  test('opening: focus on the heading, rows per category, disclosure, copy summary, back returns focus; axe clean', async () => {
    const deps = setup(TAB_STATES.normal, { ok: true, data: COUNTS });
    const { container } = await mount(deps);
    const card = await screen.findByRole('button', { name: /27 blocked/ });
    card.focus();
    fireEvent.click(card);
    const heading = await screen.findByRole('heading', { name: 'What was blocked on news.example.com' });
    expect(document.activeElement).toBe(heading);
    const advertising = container.querySelector('[data-category="ads"]');
    expect(advertising?.textContent).toBe('Advertising14Google6Criteo3Other advertising5');
    // A6: the precise figure lives inside "How this is counted".
    expect(screen.getByText('27 blocked requests matched 12 rules.').closest('details')?.querySelector('summary')?.textContent).toBe('How this is counted');
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy summary' }));
    await vi.waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Summary copied.');
    });
    expect(deps.copyText).toHaveBeenCalledWith(summaryText('news.example.com', COUNTS));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toContain('27 blocked on this page');
    });
  });

  test('unavailable (not opened from the toolbar), stale, failed and empty answers each say so', async () => {
    const cases: [ClientResult<MatchedRules>, string][] = [
      [{ ok: true, data: { kind: 'unavailable' } }, 'Counts are shown when you open this panel with the toolbar button.'],
      [{ ok: true, data: { ...COUNTS, stale: true } }, 'These counts may be out of date'],
      [{ ok: false, error: { code: 'no-answer', message: 'x' } }, 'Could not read the counts for this page.'],
      [{ ok: true, data: { ...COUNTS, total: 0, groups: [], rules: [], moreRules: 0 } }, 'Nothing has been blocked on this page.'],
    ];
    for (const [answer, text] of cases) {
      const deps = setup(TAB_STATES.normal, answer);
      const { container } = await mount(deps);
      fireEvent.click(await screen.findByRole('button', { name: /blocked/ }));
      expect((await screen.findByText(new RegExp(text.replace(/[.()]/g, '\\$&')))).textContent).toContain(text);
      expect(await axeViolations(container)).toEqual([]);
      cleanup();
    }
  });

  test('a failed copy says so', async () => {
    const deps = setup(TAB_STATES.normal, { ok: true, data: COUNTS });
    deps.copyText.mockRejectedValueOnce(new Error('denied'));
    await mount(deps);
    fireEvent.click(await screen.findByRole('button', { name: /27 blocked/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy summary' }));
    await vi.waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Could not copy. Select the text and copy it yourself.');
    });
  });

  test('restricted pages: no card and no query', async () => {
    const deps = setup(TAB_STATES.restricted, { ok: true, data: COUNTS });
    render(<PopupApp store={deps.store} now={() => NOW} privacy={deps.privacy} />);
    await deps.store.load();
    expect(screen.queryByRole('button', { name: /blocked/ })).toBeNull();
    expect(deps.matchedRules).not.toHaveBeenCalled();
  });

  test('P2-62: "Pop-ups blocked: N" when the page sentinel answers; nothing when the page has none; no destination host', async () => {
    const deps = setup(TAB_STATES.normal, { ok: true, data: COUNTS }, () => Promise.resolve({ hosts: ['popup.example'], blocked: 2, codes: ['G11'] }));
    const { container } = await mount(deps);
    fireEvent.click(await screen.findByRole('button', { name: /27 blocked/ }));
    expect((await screen.findByText('Pop-ups blocked: 2')).textContent).toBe('Pop-ups blocked: 2');
    expect(container.textContent).not.toContain('popup.example');
    expect(await axeViolations(container)).toEqual([]);
    cleanup();
    const none = setup(TAB_STATES.normal, { ok: true, data: COUNTS }, () => Promise.resolve(null));
    await mount(none);
    fireEvent.click(await screen.findByRole('button', { name: /27 blocked/ }));
    await screen.findByText('27 blocked requests matched 12 rules.');
    expect(screen.queryByText(/Pop-ups blocked/)).toBeNull();
  });
});

describe('privacy store pop-up log (P2-44)', () => {
  test('a pop-up log query that rejects leaves no log and no unhandled rejection', async () => {
    // Arrange
    const deps = setup(TAB_STATES.normal, { ok: true, data: { kind: 'unavailable' } } as unknown as ClientResult<MatchedRules>, () => Promise.reject(new Error('no frame')));

    // Act
    await deps.privacy.load(4);
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // Assert
    expect(deps.privacy.popups.value).toBeNull();
  });
});
