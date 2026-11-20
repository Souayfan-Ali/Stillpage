/**
 * `popup-sentinel` (P2-57, pop-up notes §7; decisions: design review, P2-57 notes). ISOLATED world, top-level documents,
 * `document_start`: records trusted gestures in capture listeners added before page scripts run, judges
 * new-context link clicks with `judge` (G8–G10, G11, G6, G7), stops tab-unders through the Navigation API,
 * draws the notice, keeps a page-lifetime log (≤ 20 hosts) and answers `x/popupLog`, `x/linkClickCheck`,
 * `x/popupClosed` for our own extension only. Stores nothing; no work without a click. `window.open` is
 * judged by the MAIN-world shim (P2-58), which asks this script.
 */
import { GESTURE_WINDOW_MS, TAB_UNDER_WINDOW_MS } from '../../core/popup/constants.js';
import { destinationOf, judge, type Gesture, type PopupRequest, type RuleCode } from '../../core/popup/judge.js';
import { isSameSite } from '../../core/popup/site.js';
import { BOOT_EVENT, HELLO_EVENT } from '../popup-shim/channel.js';
import { PROVIDER_ALLOWLIST } from './allowlist.js';
import type { Notice } from './notice.js';
import { isElement, isHijackOverlay, isInteractive, linkOf, type View } from './signals.js';
import type { Say } from './strings.js';

const MAX_LOG = 20;

export interface SentinelEnv {
  readonly window: Window & typeof globalThis & { readonly navigation?: EventTarget };
  readonly view: View;
  readonly notice: Notice;
  readonly now: () => number;
  /** The `popup-strict` registration's flag (Strict mode on this page). */
  readonly strict: () => boolean;
  /** The `popup-quiet` registration's flag: the notice is turned off (P2-59). */
  readonly quiet: () => boolean;
  /** Opens an address in a new tab from the user's click on the notice. */
  readonly open: (url: string) => void;
  /** Per-document random event name for the shim's requests (P2-58 handshake). */
  readonly secret: string;
  /**
   * Called on every event the judge reads (and on the window losing focus to a frame or a new tab), before
   * the judge: the entry installs the extension-message listener on the first call (guard cost, D-42b).
   * Every question our pages ask concerns such an event, so no receiver before it reads the same.
   */
  readonly arm: () => void;
  /** The notice's words from `_locales` (P2-40). */
  readonly say: Say;
}

export interface Sentinel {
  /** Answers one message from our extension; `undefined` when it is not one of ours. */
  answer(message: unknown): unknown;
}

/**
 * Why a block happened, for the breakage report (P2-62): the judge's rule (`G1`–`G13`), a stopped
 * tab-under (`TU`), or a known destination the blocked page closed (`D`).
 */
type BlockCode = RuleCode | 'TU' | 'D';

interface State {
  gesture: Gesture | null;
  link: { readonly host: string; readonly at: number } | null;
  openedAt: number | null;
  allow: boolean;
  log: readonly string[];
  /** The last new context a page script opened with our leave (one-shot `x/openedCheck`); `host` null = unknown URL. */
  scriptOpen: { readonly host: string | null; readonly at: number } | null;
  /** Blocks on this page (page lifetime) and their distinct codes. */
  blocked: number;
  codes: readonly BlockCode[];
  /** The latest gesture was on our notice: the page gets no window from it, and no notice either (P2-59). */
  onNotice: boolean;
}

const hostOf = (url: string, page: string): string | null => destinationOf(url, page)?.hostname ?? null;

function record(env: SentinelEnv, s: State, host: string | null, text: string, raw: string | null, code: BlockCode): void {
  if (host !== null && !s.log.includes(host)) s.log = [...s.log, host].slice(-MAX_LOG);
  s.blocked += 1;
  if (!s.codes.includes(code)) s.codes = [...s.codes, code];
  if (env.quiet()) return;
  // "Open it" only ever opens an http(s) address (security review MEDIUM-2: `java&#9;script:` hrefs).
  const url = raw === null ? null : destinationOf(raw, env.window.location.href)?.href ?? null;
  const actions = [
    ...(url === null ? [] : [{ label: code === 'TU' ? env.say('notice_go_there') : env.say('notice_open_it'), run: () => { env.open(url); return undefined; } }]),
    // A destination the blocked page closed offers Open it only (UI notes §6a).
    ...(code === 'D' ? [] : [{ label: env.say('notice_allow'), run: () => { s.allow = true; return env.say('notice_allow_hint'); } }]),
  ];
  env.notice.show(text, host ?? '…', actions);
}

function onPointerDown(env: SentinelEnv, s: State, e: MouseEvent): void {
  const target = isElement(e.target) ? e.target : null;
  if (!e.isTrusted || target === null) return;
  s.onNotice = env.notice.owns(target);
  s.gesture = { at: env.now(), modifier: e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1, ...signalsOf(env, target), openedCount: 0 };
}

/**
 * The DOM signals of a gesture. A page can make the reads throw (a `<form>` whose inputs shadow `matches`
 * or `parentElement`); the gesture then counts as on a non-interactive target, so a window it opens is
 * judged as from a stray click (G11), never let through for lack of a gesture (P2-43 security review).
 */
function signalsOf(env: SentinelEnv, target: Element): Pick<Gesture, 'targetInteractive' | 'targetIsOverlay' | 'link'> {
  try {
    const link = linkOf(target, env.view);
    return {
      targetInteractive: isInteractive(target, env.view), targetIsOverlay: isHijackOverlay(target, env.view),
      link: link === null ? null : { hrefAtPointerDown: link.href, hrefAtClick: link.href, visible: link.visible },
    };
  } catch {
    return { targetInteractive: false, targetIsOverlay: false, link: null };
  }
}

/** Judges a click that would open a link in a new context; `true` when it was blocked. */
function judgeLinkClick(env: SentinelEnv, s: State, e: MouseEvent): boolean {
  const target = isElement(e.target) ? e.target : null;
  const link = target === null ? null : linkOf(target, env.view);
  if (link === null) return false;
  if (e.isTrusted && s.gesture !== null && s.gesture.link !== null) s.gesture = { ...s.gesture, link: { ...s.gesture.link, hrefAtClick: link.href } };
  if (e.isTrusted && link.visible) s.link = { host: hostOf(link.href, env.window.location.href) ?? '', at: env.now() };
  const newContext = link.anchor.target === '_blank' || e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey;
  if (!newContext) return false;
  return decide(env, s, { kind: e.isTrusted ? 'link-click' : 'synthetic-click', target: 'new-context', url: link.href, pageUrl: env.window.location.href, at: env.now() }, target);
}

/** Judges one request; on allow notes the new context, on block records it and shows the notice. `true` = blocked. */
function decide(env: SentinelEnv, s: State, request: PopupRequest, target: Element | null): boolean {
  if (s.onNotice) return true;
  const verdict = judge(s.gesture, request, env.strict() ? 'strict' : 'smart', PROVIDER_ALLOWLIST);
  if (verdict.verdict === 'allow' || s.allow) {
    s.openedAt = env.now();
    if (s.gesture !== null) s.gesture = { ...s.gesture, openedCount: s.gesture.openedCount + 1 };
    return false;
  }
  if (verdict.neutraliseOverlay === true && target !== null) (target as HTMLElement).style.setProperty('pointer-events', 'none', 'important');
  const host = hostOf(request.url, request.pageUrl);
  try {
    record(env, s, host, env.say('notice_blocked') + (host ?? '…'), request.url, verdict.rule);
  } catch (error) {
    // A page can make the notice throw (a clobbered `document`): the block stands, the error is reported
    // after this decision instead of escaping it (P2-43 security review).
    env.window.queueMicrotask(() => { throw error; });
  }
  return true;
}

/** A `window.open` the shim asks about (P2-58); `true` when it is blocked (the shim then returns `null`). */
function judgeOpen(env: SentinelEnv, s: State, raw: string): boolean {
  // `window.open` resolves against the document's base URL (`<base href>`), so the judge does too (P2-43
  // security review); `baseURI` through `Node.prototype`, which a page's named elements cannot shadow.
  const base: unknown = Reflect.apply(Reflect.get(Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI') ?? {}, 'get') as () => unknown, env.window.document, []);
  const url = destinationOf(raw, typeof base === 'string' ? base : env.window.location.href)?.href ?? raw;
  const blocked = decide(env, s, { kind: 'open', target: 'new-context', url, pageUrl: env.window.location.href, at: env.now() }, null);
  if (!blocked) s.scriptOpen = { host: hostOf(url, env.window.location.href), at: env.now() };
  return blocked;
}

/** Two-way handshake (S-20): announce the secret now and once more for the shim's `hello`. */
function bootstrap(env: SentinelEnv, s: State): void {
  const doc = env.window.document;
  const announce = (): void => { doc.dispatchEvent(new env.window.CustomEvent(BOOT_EVENT, { detail: env.secret })); };
  announce();
  doc.addEventListener(HELLO_EVENT, announce, { once: true });
  doc.addEventListener(env.secret, (e) => {
    env.arm();
    const detail: unknown = (e as CustomEvent).detail;
    if (judgeOpen(env, s, typeof detail === 'string' ? detail : '')) e.preventDefault();
  });
}

/** Tab-under (pop-up notes §7.3): a script navigates this tab cross-site right after opening a new context. */
function onNavigate(env: SentinelEnv, s: State, e: Event): void {
  const n = e as Event & { readonly userInitiated?: boolean; readonly cancelable: boolean; readonly navigationType?: string; readonly destination?: { readonly url: string } };
  const url = n.destination?.url ?? '';
  const host = hostOf(url, env.window.location.href);
  const recent = s.openedAt !== null && env.now() - s.openedAt <= TAB_UNDER_WINDOW_MS;
  const newGesture = s.gesture !== null && s.openedAt !== null && s.gesture.at > s.openedAt;
  if (!recent || newGesture || n.userInitiated === true || !n.cancelable || n.navigationType === 'reload' || s.allow) return;
  if (host !== null && isSameSite(host, env.window.location.hostname)) return;
  e.preventDefault();
  s.openedAt = null;
  record(env, s, host, env.say('notice_redirect') + (host ?? '…'), url, 'TU');
}

function answer(env: SentinelEnv, s: State, message: unknown): unknown {
  if (typeof message !== 'object' || message === null) return undefined;
  const m = message as { readonly type?: unknown; readonly host?: unknown };
  if (m.type === 'x/popupLog') return { hosts: [...s.log], blocked: s.blocked, codes: [...s.codes] };
  if (typeof m.host !== 'string') return undefined;
  if (m.type === 'x/openedCheck') {
    const open = s.scriptOpen;
    const yes = open !== null && env.now() - open.at <= GESTURE_WINDOW_MS && (open.host === null || open.host === m.host);
    if (yes) s.scriptOpen = null;
    return yes;
  }
  if (m.type === 'x/linkClickCheck') return s.link !== null && s.link.host === m.host && env.now() - s.link.at <= GESTURE_WINDOW_MS;
  if (m.type === 'x/popupClosed') {
    record(env, s, m.host, env.say('notice_blocked') + m.host, `https://${m.host}/`, 'D');
    return true;
  }
  return undefined;
}

export function startSentinel(env: SentinelEnv): Sentinel {
  const s: State = { gesture: null, link: null, openedAt: null, allow: false, log: [], scriptOpen: null, blocked: 0, codes: [], onNotice: false };
  const w = env.window;
  bootstrap(env, s);
  for (const type of ['pointerdown', 'keydown', 'click', 'auxclick', 'blur']) w.addEventListener(type, env.arm, true);
  w.addEventListener('pointerdown', (e) => { onPointerDown(env, s, e); }, true);
  w.addEventListener('keydown', (e) => {
    if (!e.isTrusted || (e.key !== 'Enter' && e.key !== ' ')) return;
    s.onNotice = env.notice.owns(e.target);
    s.gesture = { at: env.now(), modifier: e.ctrlKey || e.metaKey || e.shiftKey, targetInteractive: true, targetIsOverlay: false, link: null, openedCount: 0 };
  }, true);
  const onClick = (e: MouseEvent): void => {
    if (judgeLinkClick(env, s, e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  w.addEventListener('click', onClick, true);
  w.addEventListener('auxclick', onClick, true);
  // The Navigation API (Chrome ≥ 102); absent elsewhere, then no tab-under stop.
  const navigation = (w as { readonly navigation?: EventTarget }).navigation;
  navigation?.addEventListener('navigate', (e) => { onNavigate(env, s, e); });
  return { answer: (message) => answer(env, s, message) };
}
