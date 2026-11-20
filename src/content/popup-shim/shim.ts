/**
 * `popup-shim` (P2-58, cosmetic notes §6a, pop-up notes §7.1): MAIN world, top-level documents, `document_start`.
 * It only intercepts and asks. Natives are captured once; the `open` a realm has at install becomes a
 * `Proxy` behind an accessor, and that proxy is the one place a call is judged, with the URL that will
 * really be opened: the argument is turned into a string once, before judging and outside any guard, and
 * that string is what the native gets (a page `toString` cannot open unjudged or swap the URL; security
 * review HIGH-1). A page or `nowoif` assignment is kept as is: whatever it calls ends in the judged proxy,
 * so a call chain is judged once (A12). The three-argument `document.open` (an alias of `window.open`) is
 * judged too. Same-origin child realms are wrapped when reached through `contentWindow` /
 * `contentDocument`, again after they navigate (the accessor is checked, not the `WindowProxy`); a realm
 * reached only through `window[i]` / `frames[i]` before that is a documented gap (pop-up notes §7.1). A request
 * is a cancelable event named by the sentinel's secret; `false` from `dispatchEvent` means blocked and the
 * call returns `null`. Any failure of ours falls through to the native call: a broken guard must never break a
 * page (an error the page's own argument throws while being turned into a string is the page's, and is rethrown).
 */
import { BOOT_EVENT, HELLO_EVENT } from './channel.js';

type Fn = (...args: unknown[]) => unknown;

export function installShim(win: Window & typeof globalThis): void {
  const doc = win.document;
  const get = Reflect.get;
  const dispatch = get(win.EventTarget.prototype, 'dispatchEvent') as Fn;
  const listen = get(win.EventTarget.prototype, 'addEventListener') as Fn;
  const unlisten = get(win.EventTarget.prototype, 'removeEventListener') as Fn;
  const Custom = win.CustomEvent;
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const Proxied = Proxy;
  const text = win.String;
  let secret: string | null = null;
  const onBoot = (e: Event): void => { const d = (e as CustomEvent<unknown>).detail; if (secret === null && typeof d === 'string') secret = d; };
  // The sentinel (ISOLATED, earlier) announced before this script existed: ask once, synchronously, then
  // stop listening, so a page can never hand the shim a secret of its own (review LOW).
  apply(listen, doc, [BOOT_EVENT, onBoot]);
  apply(dispatch, doc, [new Custom(HELLO_EVENT)]);
  apply(unlisten, doc, [BOOT_EVENT, onBoot]);

  /** `true` lets the window open: no sentinel or any error never blocks. */
  const allowed = (url: string): boolean => {
    try {
      return secret === null || apply(dispatch, doc, [new Custom(secret, { detail: url, cancelable: true })]) === true;
    } catch {
      return true;
    }
  };
  /** Judges `args[0]` (the URL) once and calls `target` with that same string, or returns `null`. */
  const judged = (target: Fn, self: unknown, args: unknown[]): unknown => {
    // A page `toString` that throws gets its own error back, as from the native call; never a second,
    // unjudged stringification by the native (P2-43 security review).
    const url = args[0] === undefined ? '' : text(args[0]);
    return allowed(url) ? apply(target, self, args.length === 0 ? args : [url, ...args.slice(1)]) : null;
  };
  const ours = new WeakSet<object>();
  const guard = (w: Window | null): void => {
    try {
      if (w === null || ours.has(get(descriptor(w, 'open') ?? {}, 'get') as object)) return;
      let current: unknown = new Proxied(get(w, 'open') as Fn, { apply: judged });
      const getter = (): unknown => current;
      define(w, 'open', { configurable: true, enumerable: true, get: getter, set: (v: unknown) => { current = v; } });
      ours.add(getter);
      const proto = (get(w, 'Document') as { readonly prototype: object }).prototype;
      const docOpen = get(proto, 'open') as Fn;
      define(proto, 'open', { configurable: true, enumerable: true, writable: true, value: new Proxied(docOpen, {
        apply: (target, self, args: unknown[]) => (args.length > 2 ? judged(target, self, args) : apply(target, self, args)),
      }) });
    } catch {
      // A cross-origin realm: not ours to patch (left to the destination rules, pop-up notes §7.1).
    }
  };
  guard(win);
  for (const element of ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement', 'HTMLEmbedElement']) {
    const proto = (get(win, element) as { readonly prototype: object } | undefined)?.prototype;
    for (const name of ['contentWindow', 'contentDocument'] as const) {
      const d = proto === undefined ? undefined : descriptor(proto, name);
      const read: unknown = d === undefined ? undefined : get(d, 'get');
      if (proto === undefined || d === undefined || typeof read !== 'function') continue;
      define(proto, name, {
        ...d,
        get(this: Element) {
          const value: unknown = apply(read, this, []);
          guard(name === 'contentWindow' ? (value as Window | null) : ((value as Document | null)?.defaultView ?? null));
          return value;
        },
      });
    }
  }
}
