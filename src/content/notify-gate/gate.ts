/**
 * `notify-gate` (P2-63, cosmetic notes §6a, pop-up notes P15): MAIN world, registered only while the Notification
 * prompts pack is on. A page that calls `Notification.requestPermission()` or `PushManager.subscribe()`
 * **without user activation** while the permission is still undecided gets `"default"` (or a rejection)
 * and Chrome shows no prompt; after a real click, or once the user has decided, the native method runs
 * untouched. The natives are captured before any page script; a failure inside the gate falls back to the
 * native call (fail open: the gate must never break a page). No data, no messages, nothing stored.
 */

/** The parts of the page's globals the gate needs (injected so it is unit-tested). */
export interface GateScope {
  readonly Notification?: {
    readonly permission?: string;
    requestPermission?: (callback?: (result: string) => void) => Promise<string>;
  };
  readonly PushManager?: { readonly prototype: { subscribe?: (...args: unknown[]) => Promise<unknown> } };
  readonly navigator?: { readonly userActivation?: { readonly isActive: boolean } };
  readonly DOMException?: new (message: string, name: string) => Error;
}

/** True when a prompt would appear without the user having just acted (no activation, undecided). */
function suppress(scope: GateScope, readPermission: () => unknown): boolean {
  try {
    const active = scope.navigator?.userActivation?.isActive;
    // Without the User Activation API we cannot tell, so the native prompt runs (fail open).
    return active === false && readPermission() === 'default';
  } catch {
    return false;
  }
}

function gateRequest(scope: GateScope, readPermission: () => unknown): void {
  const N = scope.Notification;
  const native = N?.requestPermission;
  if (N === undefined || typeof native !== 'function') return;
  const gated = function requestPermission(this: unknown, callback?: (result: string) => void): Promise<string> {
    if (!suppress(scope, readPermission)) return native.call(this, callback);
    if (typeof callback === 'function') queueMicrotask(() => { callback('default'); });
    return Promise.resolve('default');
  };
  Object.defineProperty(N, 'requestPermission', { value: gated, writable: true, configurable: true });
}

function gateSubscribe(scope: GateScope, readPermission: () => unknown): void {
  const proto = scope.PushManager?.prototype;
  const native = proto?.subscribe;
  if (proto === undefined || typeof native !== 'function') return;
  const Err = scope.DOMException;
  const gated = function subscribe(this: unknown, ...args: unknown[]): Promise<unknown> {
    if (!suppress(scope, readPermission)) return native.apply(this, args);
    return Promise.reject(Err === undefined ? new Error('Registration failed - permission not granted') : new Err('Registration failed - permission not granted', 'NotAllowedError'));
  };
  Object.defineProperty(proto, 'subscribe', { value: gated, writable: true, configurable: true });
}

/** Installs the gate on `scope` (the page's `globalThis`). */
export function installNotifyGate(scope: GateScope): void {
  const N = scope.Notification;
  // The permission getter is read through its captured descriptor, never a later page override.
  const getterOf = (o: object): ((this: unknown) => unknown) | undefined => Reflect.get(Object.getOwnPropertyDescriptor(o, 'permission') ?? {}, 'get') as ((this: unknown) => unknown) | undefined;
  const getter = N === undefined ? undefined : (getterOf(Object.getPrototypeOf(N) as object) ?? getterOf(N));
  const readPermission = (): unknown => (getter === undefined ? N?.permission : getter.call(N));
  gateRequest(scope, readPermission);
  gateSubscribe(scope, readPermission);
}
