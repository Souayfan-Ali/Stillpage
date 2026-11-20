import { describe, expect, test, vi } from 'vitest';
import { createClient } from '../../../../src/features/popup/client.js';
import { parseMessage } from '../../../../src/core/messaging/parse.js';
import { TAB_STATES } from '../../../fixtures/panel/tabStates.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const PANEL_SENDER = {
  id: RUNTIME_ID,
  url: `chrome-extension://${RUNTIME_ID}/popup.html`,
  origin: `chrome-extension://${RUNTIME_ID}`,
};
const fixedRandom = (): Uint8Array => new Uint8Array([0, 1, 2, 254, 255, 16, 32, 64, 128]);

describe('panel client (P1-12 envelope)', () => {
  test('sends a v1 envelope that the worker-side parser accepts from the panel', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true, data: TAB_STATES.normal }));
    await createClient({ send }, fixedRandom).tabState(7);
    const [envelope] = send.mock.calls[0] as unknown as [unknown];
    expect(envelope).toEqual({
      v: 1,
      type: 'q/tabState',
      id: '000102feff10204080',
      payload: { tabId: 7 },
    });
    expect(parseMessage(envelope, PANEL_SENDER, RUNTIME_ID).ok).toBe(true);
  });

  test('each message gets a fresh id', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true, data: { status: 'applied' } }));
    const client = createClient({ send });
    await client.command('c/setSiteLevel', { hostname: 'a.example', level: 'light' });
    await client.command('c/setSiteLevel', { hostname: 'a.example', level: 'light' });
    const ids = send.mock.calls.map((call) => (call as unknown as [{ id: string }])[0].id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toMatch(/^[0-9a-f]{18}$/);
  });

  test('returns the validated tab state', async () => {
    const result = await createClient({
      send: () => Promise.resolve({ ok: true, data: TAB_STATES.limited }),
    }).tabState(1);
    expect(result).toEqual({ ok: true, data: TAB_STATES.limited });
  });

  test.each([
    ['an extra key', { ...TAB_STATES.normal, url: 'https://news.example.com/private?q=1' }],
    ['a non-canonical host', { ...TAB_STATES.normal, host: 'News.Example.com' }],
    ['an unknown level', { ...TAB_STATES.normal, level: 'max' }],
    ['a missing field', { page: 'web' }],
  ])('refuses an answer with %s', async (_name, data) => {
    const result = await createClient({ send: () => Promise.resolve({ ok: true, data }) }).tabState(1);
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid-answer', message: expect.any(String) as string },
    });
  });

  test('maps the worker errors: not-implemented stays distinct, the rest are refusals', async () => {
    const notYet = await createClient({
      send: () => Promise.resolve({ ok: false, error: { code: 'not-implemented', message: 'x' } }),
    }).tabState(1);
    const refused = await createClient({
      send: () => Promise.resolve({ ok: false, error: { code: 'forbidden-sender', message: 'x' } }),
    }).tabState(1);
    expect(notYet.ok ? null : notYet.error.code).toBe('not-implemented');
    expect(refused.ok ? null : refused.error.code).toBe('refused');
  });

  test('a rejected send (worker gone, no receiver) is a no-answer error, never a throw', async () => {
    const result = await createClient({
      send: () => Promise.reject(new Error('Receiving end does not exist')),
    }).tabState(1);
    expect(result.ok ? null : result.error.code).toBe('no-answer');
  });

  test('never sends a payload the worker would refuse', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true, data: { status: 'applied' } }));
    const client = createClient({ send });
    const results = await Promise.all([
      client.tabState(-1),
      client.command('c/setSiteLevel', { hostname: 'Not A Host', level: 'light' }),
      client.command('c/setSiteLevel', { hostname: 'a.example', level: 'max' as 'light' }),
    ]);
    expect(results.map((r) => (r.ok ? null : r.error.code))).toEqual(['invalid-request', 'invalid-request', 'invalid-request']);
    expect(send).not.toHaveBeenCalled();
  });

  test('a command answer only needs a status', async () => {
    const ok = await createClient({
      send: () => Promise.resolve({ ok: true, data: { status: 'unchanged', skippedPacks: [] } }),
    }).command('c/reconcile', {});
    const bad = await createClient({
      send: () => Promise.resolve({ ok: true, data: null }),
    }).command('c/reconcile', {});
    expect(ok).toEqual({ ok: true, data: null });
    expect(bad.ok).toBe(false);
    const dismissed = await createClient({ send: () => Promise.resolve({ ok: true, data: { dismissed: true } }) }).command('c/dismissNotice', {});
    const forged = await createClient({ send: () => Promise.resolve({ ok: true, data: { dismissed: true, extra: 1 } }) }).command('c/dismissNotice', {});
    expect(dismissed).toEqual({ ok: true, data: null });
    expect(forged.ok).toBe(false);
  });

  test('c/removeUserFilter answers with null data (P3-17: Remove in the panel)', async () => {
    const removed = await createClient({ send: () => Promise.resolve({ ok: true, data: null }) }).command('c/removeUserFilter', { hostname: 'a.example', selector: '#ad' });
    expect(removed).toEqual({ ok: true, data: null });
    const forged = await createClient({ send: () => Promise.resolve({ ok: true, data: { status: 'x' } }) }).command('c/removeUserFilter', { hostname: 'a.example', selector: '#ad' });
    expect(forged.ok).toBe(false);
  });

  test('a worker that never answers is a no-answer error after the timeout', async () => {
    const result = await createClient({ send: () => new Promise(() => undefined) }, undefined, 10).tabState(1);
    expect(result.ok ? null : result.error.code).toBe('no-answer');
  });
});

describe('c/setPack on the page side (P2-26, P2-27)', () => {
  const send = (answer: unknown) => createClient({ send: () => Promise.resolve(answer) });

  test('offerThorough is read from the answer', async () => {
    expect(await send({ ok: true, data: { status: 'applied', skippedPacks: [], offerThorough: true } }).setPack('cookies', true)).toEqual({ ok: true, data: { offerThorough: true } });
    expect((await send({ ok: true, data: { status: 'applied' } }).setPack('cookies', true)).ok).toBe(false);
  });

  test('no-capacity keeps a well-formed detail and drops a malformed one', async () => {
    const detail = { reason: 'rule-pool', needed: 1200, available: 300 };
    expect(await send({ ok: false, error: { code: 'no-capacity', message: 'x', detail } }).setPack('reg-de', true)).toEqual({ ok: false, error: { code: 'no-capacity', message: 'x', detail } });
    for (const bad of [{ ...detail, reason: 'evil' }, { ...detail, needed: -1 }, { ...detail, extra: 1 }, 'text']) {
      expect(await send({ ok: false, error: { code: 'no-capacity', message: 'x', detail: bad } }).setPack('reg-de', true)).toEqual({ ok: false, error: { code: 'no-capacity', message: 'x' } });
    }
  });
});
