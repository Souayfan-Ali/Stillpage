// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { PRODUCT_NAME } from '../../../src/core/brand.js';
import { isRealClick, renderFallback, runBlockedPage, type BlockedDeps } from '../../../src/features/blocked-page/page.js';
import { axeViolations } from '../ui/axe.js';

const HASH = '#https://ad.example.net/landing?id=7';

function deps(over: Partial<BlockedDeps> = {}) {
  const calls = { closed: [] as number[], back: 0, navigated: [] as string[], proceeded: [] as string[], asked: [] as number[] };
  const d: BlockedDeps = {
    document, hash: HASH, referrer: '', historyLength: 1,
    currentTab: () => Promise.resolve({ id: 9 }),
    askOpener: (opener) => { calls.asked.push(opener); return Promise.resolve({ scriptOpened: true, linkClick: false }); },
    closeTab: (id) => { calls.closed.push(id); return Promise.resolve(); },
    goBack: () => { calls.back += 1; },
    proceed: (host) => { calls.proceeded.push(host); return Promise.resolve(true); },
    navigate: (url) => { calls.navigated.push(url); },
    framed: false,
    userActive: () => true,
    ...over,
  };
  document.body.replaceChildren();
  return { d, calls };
}

const button = (name: string): HTMLButtonElement => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === name);
  if (b === undefined) throw new Error(`no button ${name}`);
  return b;
};

describe('runBlockedPage', () => {
  test('a pop-up nobody asked for closes itself without drawing anything', async () => {
    const notified: [number, string][] = [];
    const { d, calls } = deps({ currentTab: () => Promise.resolve({ id: 9, openerTabId: 4 }), notifyOpener: (o, h) => { notified.push([o, h]); return Promise.resolve(); } });
    expect(await runBlockedPage(d)).toBe('closed');
    expect(notified).toEqual([[4, 'ad.example.net']]);
    expect(calls).toMatchObject({ closed: [9], asked: [4] });
    expect(document.body.children).toHaveLength(0);
  });

  test('a link the user clicked: stays with the link line, Close tab first', async () => {
    const { d, calls } = deps({ currentTab: () => Promise.resolve({ id: 9, openerTabId: 4 }), askOpener: () => Promise.resolve({ scriptOpened: false, linkClick: true }) });
    expect(await runBlockedPage(d)).toBe('shown');
    expect(document.querySelector('[data-reason]')?.textContent).toBe('This link leads to a site known for pop-up ads.');
    expect(document.querySelector('.actions button')?.textContent).toBe('Close tab');
    button('Close tab').click();
    expect(calls.closed).toEqual([9]);
  });

  test('a user-opened tab with an opener id but no script confirmation (guard off, Ctrl+T) stays (design review)', async () => {
    const { d, calls } = deps({ currentTab: () => Promise.resolve({ id: 9, openerTabId: 4 }), askOpener: () => Promise.resolve({ scriptOpened: false, linkClick: false }) });
    expect(await runBlockedPage(d)).toBe('shown');
    expect(calls.closed).toEqual([]);
    expect(document.querySelector('.actions button')?.textContent).toBe('Close tab');
  });

  test('a fresh tab without an opener: Close tab first, Proceed once offered; the host is text', async () => {
    const { d } = deps();
    expect(await runBlockedPage(d)).toBe('shown');
    expect(document.querySelector('strong')?.textContent).toBe('ad.example.net');
    expect(document.body.textContent).not.toContain('landing?id=7');
    expect([...document.querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Close tab']);
    expect(document.querySelector('.proceed button.link')?.textContent).toBe('Proceed once');
  });

  test('E22/E23: the product name beside the mark; Proceed once a text link under the safe buttons, next in Tab order', async () => {
    const { d } = deps({ historyLength: 3 });
    await runBlockedPage(d);
    expect(document.querySelector('main > .band .brand')?.textContent).toBe(PRODUCT_NAME);
    const actions = document.querySelector('.actions');
    const proceed = button('Proceed once');
    expect(proceed.closest('.actions')).toBeNull();
    expect(proceed.classList.contains('link')).toBe(true);
    expect(actions !== null && (actions.compareDocumentPosition(proceed) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    expect([...document.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Go back', 'Close tab', 'Proceed once']);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  test('an existing tab: Go back first, the sender is named, no opener question', async () => {
    const { d, calls } = deps({ historyLength: 3, referrer: 'https://news.example.com/x', currentTab: () => Promise.resolve({ id: 9, openerTabId: 4 }) });
    await runBlockedPage(d);
    expect(calls.asked).toEqual([]);
    expect([...document.querySelectorAll('.actions button')].map((b) => b.textContent)).toEqual(['Go back', 'Close tab']);
    expect(document.querySelector('[data-sender]')?.textContent).toBe('You were sent here by news.example.com.');
    button('Go back').click();
    expect(calls.back).toBe(1);
  });

  test('Proceed once: asks the worker, then replaces the page with the parsed address', async () => {
    const { d, calls } = deps();
    await runBlockedPage(d);
    button('Proceed once').click();
    await vi.waitFor(() => { expect(calls.navigated).toEqual(['https://ad.example.net/landing?id=7']); });
    expect(calls.proceeded).toEqual(['ad.example.net']);
  });

  test('Proceed once refused or failing: stays and says so', async () => {
    const { d, calls } = deps({ proceed: () => Promise.reject(new Error('no')) });
    await runBlockedPage(d);
    button('Proceed once').click();
    await vi.waitFor(() => { expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/could not/i); });
    expect(calls.navigated).toEqual([]);
    expect(button('Proceed once').disabled).toBe(false);
  });

  test('a hostile fragment: no host, no Proceed once, no markup', async () => {
    const { d } = deps({ hash: '#javascript:alert(1)//<img src=x onerror=alert(2)>' });
    expect(await runBlockedPage(d)).toBe('shown');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('strong')).toBeNull();
    expect([...document.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Close tab']);
  });

  test('a markup-looking referrer is never rendered as markup', async () => {
    const { d } = deps({ historyLength: 2, referrer: 'https://<b>x</b>/' });
    await runBlockedPage(d);
    expect(document.querySelector('[data-sender]')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  test('no current tab: shows the page, Close tab does nothing harmful', async () => {
    const { d, calls } = deps({ currentTab: () => Promise.resolve(null) });
    expect(await runBlockedPage(d)).toBe('shown');
    button('Close tab').click();
    expect(calls.closed).toEqual([]);
  });

  test('a framed copy draws nothing and closes nothing (security review MEDIUM-3)', async () => {
    const { d, calls } = deps({ framed: true, currentTab: () => Promise.resolve({ id: 9, openerTabId: 4 }) });
    expect(await runBlockedPage(d)).toBe('framed');
    expect([calls.closed, calls.asked, document.body.children.length]).toEqual([[], [], 0]);
  });

  test('Proceed once without user activation does nothing', async () => {
    const { d, calls } = deps({ userActive: () => false });
    await runBlockedPage(d);
    button('Proceed once').click();
    await new Promise((r) => { setTimeout(r, 0); });
    expect(calls.proceeded).toEqual([]);
  });

  test('Proceed once hands the click to the activation check; a script click is never a real one (J15)', async () => {
    const seen: Event[] = [];
    const { d, calls } = deps({ userActive: (e) => { seen.push(e); return isRealClick(e, true); } });
    await runBlockedPage(d);
    button('Proceed once').click();
    button('Proceed once').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => { setTimeout(r, 0); });
    expect(seen.map((e) => e.type)).toEqual(['click', 'click']);
    expect(calls.proceeded).toEqual([]);
    expect(isRealClick({ isTrusted: true } as Event, true)).toBe(true);
    expect(isRealClick({ isTrusted: true } as Event, false)).toBe(false);
  });

  test('a refused self-close shows the page instead of a blank tab (MEDIUM-2)', async () => {
    const { d } = deps({ currentTab: () => Promise.resolve({ id: 9, openerTabId: 4 }), closeTab: () => Promise.reject(new Error('no')) });
    expect(await runBlockedPage(d)).toBe('shown');
    expect(document.querySelector('h1')?.textContent).toBe('This page was blocked');
  });

  test('the fallback page offers a way back', async () => {
    const { calls, d } = deps();
    renderFallback(d);
    expect(document.querySelector('main > .band .brand')?.textContent).toBe(PRODUCT_NAME);
    button('Go back').click();
    expect(calls.back).toBe(1);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  test('focus starts on the primary button, so Enter does the safe thing (UI notes §9, P2-39)', async () => {
    const { d } = deps({ historyLength: 2 });
    await runBlockedPage(d);
    expect(document.activeElement).toBe(button('Go back'));
    const fresh = deps();
    await runBlockedPage(fresh.d);
    expect(document.activeElement).toBe(button('Close tab'));
    renderFallback(fresh.d);
    expect(document.activeElement).toBe(button('Go back'));
  });

  test('axe: no violations', async () => {
    const { d } = deps({ historyLength: 2, referrer: 'https://news.example.com/' });
    await runBlockedPage(d);
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('lifted destination (D-55a item 3): the user sees the exact address Proceed once covers', () => {
  test('shows the full address without its fragment, as text, beside the host', async () => {
    const { d } = deps({ hash: '#https://ad.example.net/landing?id=7&x=<b>#frag', isLifted: (host) => Promise.resolve(host === 'ad.example.net') });
    expect(await runBlockedPage(d)).toBe('shown');
    const line = document.querySelector('[data-exact-url]');
    expect(line?.textContent).toContain('Proceed once opens this address:');
    expect(line?.querySelector('code')?.textContent).toBe('https://ad.example.net/landing?id=7&x=%3Cb%3E');
    expect(document.querySelector('b')).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  test('Proceed once navigates to exactly that address (no fragment: Chromium matches navigations with it)', async () => {
    const { d, calls } = deps({ hash: '#https://ad.example.net/landing?id=7#top', isLifted: () => Promise.resolve(true) });
    await runBlockedPage(d);
    button('Proceed once').click();
    await vi.waitFor(() => { expect(calls.navigated).toEqual(['https://ad.example.net/landing?id=7']); });
  });

  test('not lifted: Proceed once keeps the whole address, fragment included', async () => {
    const { d, calls } = deps({ hash: '#https://ad.example.net/landing?id=7#top', isLifted: () => Promise.resolve(false) });
    await runBlockedPage(d);
    button('Proceed once').click();
    await vi.waitFor(() => { expect(calls.navigated).toEqual(['https://ad.example.net/landing?id=7#top']); });
  });

  test('not lifted, or the lookup fails: the address stays hidden', async () => {
    const { d } = deps({ isLifted: () => Promise.resolve(false) });
    await runBlockedPage(d);
    expect(document.querySelector('[data-exact-url]')).toBeNull();
    const failing = deps({ isLifted: () => Promise.reject(new Error('no file')) });
    expect(await runBlockedPage(failing.d)).toBe('shown');
    expect(document.querySelector('[data-exact-url]')).toBeNull();
  });
});
