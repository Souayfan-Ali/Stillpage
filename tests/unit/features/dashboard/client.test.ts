import * as v from 'valibot';
import { describe, expect, test, vi } from 'vitest';
import { parseMessage } from '../../../../src/core/messaging/parse.js';
import { AnySchema, createRequest } from '../../../../src/features/dashboard/client.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const DASHBOARD = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/dashboard.html`, origin: `chrome-extension://${RUNTIME_ID}` };
const fixedRandom = (): Uint8Array => new Uint8Array([0, 1, 2, 254, 255, 16, 32, 64, 128]);
const Count = v.strictObject({ n: v.number() });

describe('settings page client', () => {
  test('sends a v1 envelope the worker-side parser accepts from the dashboard', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true, data: {} }));
    await createRequest({ send }, fixedRandom)('c/setGpc', { enabled: true }, AnySchema);
    const [envelope] = send.mock.calls[0] as unknown as [unknown];
    expect(envelope).toEqual({ v: 1, type: 'c/setGpc', id: '000102feff10204080', payload: { enabled: true } });
    expect(parseMessage(envelope, DASHBOARD, RUNTIME_ID).ok).toBe(true);
  });

  test('never sends a payload the worker would refuse', async () => {
    const send = vi.fn();
    const result = await createRequest({ send })('c/setPack', { pack: 'Bad Id', enabled: true }, AnySchema);
    expect(result).toEqual({ ok: false, error: { code: 'invalid-request' } });
    expect(send).not.toHaveBeenCalled();
  });

  test('validates the answer data with the given schema', async () => {
    const request = createRequest({ send: () => Promise.resolve({ ok: true, data: { n: 3 } }) });
    expect(await request('c/reconcile', {}, Count)).toEqual({ ok: true, data: { n: 3 } });
    const bad = createRequest({ send: () => Promise.resolve({ ok: true, data: { n: 'x' } }) });
    expect(await bad('c/reconcile', {}, Count)).toEqual({ ok: false, error: { code: 'invalid-answer' } });
  });

  test('keeps the refusal code and a valid capacity detail', async () => {
    const detail = { reason: 'rule-pool', needed: 2400, available: 1100 };
    const request = createRequest({ send: () => Promise.resolve({ ok: false, error: { code: 'no-capacity', message: 'm', detail } }) });
    expect(await request('c/setPack', { pack: 'cookies', enabled: true }, AnySchema)).toEqual({
      ok: false,
      error: { code: 'refused', reason: 'no-capacity', detail },
    });
  });

  test('drops a malformed detail but keeps the refusal', async () => {
    const detail = { reason: 'rule-pool', needed: -1, available: 'lots' };
    const request = createRequest({ send: () => Promise.resolve({ ok: false, error: { code: 'no-capacity', message: 'm', detail } }) });
    expect(await request('c/setPack', { pack: 'cookies', enabled: true }, AnySchema)).toEqual({ ok: false, error: { code: 'refused', reason: 'no-capacity' } });
  });

  test('a rejected send or a silent worker is "no answer"', async () => {
    const rejected = createRequest({ send: () => Promise.reject(new Error('gone')) });
    expect(await rejected('c/reconcile', {}, AnySchema)).toEqual({ ok: false, error: { code: 'no-answer' } });
    const silent = createRequest({ send: () => new Promise(() => undefined) }, fixedRandom, 5);
    expect(await silent('c/reconcile', {}, AnySchema)).toEqual({ ok: false, error: { code: 'no-answer' } });
  });
});
