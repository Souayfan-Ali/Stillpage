/** `handleMessage` never rejects, and a handler that throws is logged, not dropped (P2-44). */
import { describe, expect, test } from 'vitest';
import { handleMessage, type MessageContext } from '../../../src/background/messages.js';
import type { Logger } from '../../../src/core/log.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${ID}`;
const POPUP = { id: ID, url: `${ORIGIN}/popup.html`, origin: ORIGIN };

describe('handleMessage', () => {
  test('answers internal and logs the cause when a handler rejects', async () => {
    // Arrange
    const logged: { message: string; detail: unknown }[] = [];
    const log: Logger = { warn: () => undefined, error: (message, detail) => { logged.push({ message, detail }); } };
    const cause = new Error('vault gone');
    const ctx = { runtimeId: ID, ports: { log }, features: { startPicker: () => Promise.reject(cause) } } as unknown as MessageContext;
    const message = { v: 1, type: 'c/startPicker', id: 'm1', payload: { tabId: 7, mode: 'hide' } };

    // Act
    const answer = await handleMessage(message, POPUP, ctx);

    // Assert
    expect(answer).toEqual({ ok: false, error: { code: 'internal', message: 'internal error' } });
    expect(logged).toEqual([{ message: 'c/startPicker failed', detail: cause }]);
  });
});
