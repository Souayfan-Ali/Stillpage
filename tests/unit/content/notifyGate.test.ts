import { describe, expect, test, vi } from 'vitest';
import { installNotifyGate, type GateScope } from '../../../src/content/notify-gate/gate.js';

function scope(over: { active?: boolean | undefined; permission?: string } = {}) {
  const requestPermission = vi.fn<(cb?: (r: string) => void) => Promise<string>>(() => Promise.resolve('granted'));
  const subscribe = vi.fn(() => Promise.resolve({ endpoint: 'x' }));
  let permission = over.permission ?? 'default';
  const N = { requestPermission };
  Object.defineProperty(N, 'permission', { get: () => permission, configurable: true });
  const s = {
    Notification: N,
    PushManager: { prototype: { subscribe } },
    navigator: over.active === undefined && 'active' in over ? {} : { userActivation: { isActive: over.active ?? false } },
    DOMException: class extends Error {
      constructor(message: string, override readonly name: string) {
        super(message);
      }
    },
  } as unknown as GateScope;
  installNotifyGate(s);
  return { s, requestPermission, subscribe, setPermission: (p: string) => { permission = p; } };
}

describe('notify-gate (P2-63)', () => {
  test('a prompt without user activation while undecided: "default", no native prompt; the legacy callback too', async () => {
    const { s, requestPermission } = scope();
    const cb = vi.fn();
    await expect(s.Notification?.requestPermission?.(cb)).resolves.toBe('default');
    await Promise.resolve();
    expect(cb).toHaveBeenCalledWith('default');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  test('after a real click (user activation) the native prompt runs untouched', async () => {
    const { s, requestPermission } = scope({ active: true });
    await expect(s.Notification?.requestPermission?.()).resolves.toBe('granted');
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  test('once the user has decided, nothing is gated; without the User Activation API the gate fails open', async () => {
    const decided = scope({ permission: 'denied' });
    await decided.s.Notification?.requestPermission?.();
    expect(decided.requestPermission).toHaveBeenCalledTimes(1);
    const unknown = scope({ active: undefined });
    await unknown.s.Notification?.requestPermission?.();
    expect(unknown.requestPermission).toHaveBeenCalledTimes(1);
  });

  test('PushManager.subscribe without activation is rejected as NotAllowedError; with activation it runs', async () => {
    const { s, subscribe } = scope();
    await expect(s.PushManager?.prototype.subscribe?.({})).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(subscribe).not.toHaveBeenCalled();
    const ok = scope({ active: true });
    await expect(ok.s.PushManager?.prototype.subscribe?.({})).resolves.toEqual({ endpoint: 'x' });
  });

  test('a page overriding Notification.permission later does not change what the gate reads', async () => {
    const { s, requestPermission } = scope();
    Object.defineProperty(s.Notification ?? {}, 'permission', { get: () => 'granted', configurable: true });
    await expect(s.Notification?.requestPermission?.()).resolves.toBe('default');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  test('pages without the APIs are left alone', () => {
    expect(() => {
      installNotifyGate({});
    }).not.toThrow();
  });
});
