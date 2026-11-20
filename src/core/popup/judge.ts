/**
 * Pop-up decision core (P2-56, pop-up notes §7.3): `judge(gesture, request, mode)` returns a verdict and
 * the rule (G1–G13) that decided it; first matching row wins. Pure: the sentinel (P2-57) collects the
 * signals of §7.2 from the DOM and passes them in. The first draft's G4 frame clause is dormant: the
 * guard runs in top-level documents only. An empty URL, `about:blank`, `blob:`, `data:` and anything
 * that is not http(s) are *unknown* destinations, treated as cross-site (S-20 took `open('')` as
 * same-site because it resolved the empty string against the page).
 */
import { matchesAllowlist, type CompiledAllowlist } from './allowlist.js';
import { GESTURE_WINDOW_MS } from './constants.js';
import { isSameSite } from './site.js';

/** `off` stands for G1: "Allow pop-ups" on this site, or level Off / Light (normally not injected at all). */
export type GuardMode = 'off' | 'smart' | 'strict';
export type RuleCode = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9' | 'G10' | 'G11' | 'G12' | 'G13';

/** The last trusted `pointerdown` / `click` / `keydown` and what it hit (pop-up notes §7.2). */
export interface Gesture {
  readonly at: number;
  /** Ctrl, Cmd, Shift or the middle button: the user asked for a new tab. */
  readonly modifier: boolean;
  readonly targetInteractive: boolean;
  /** The target passed the hijack-overlay test (§7.4). */
  readonly targetIsOverlay: boolean;
  /** Nearest `a[href]` around the target: its `href` at `pointerdown` and at `click`, and visibility. */
  readonly link: { readonly hrefAtPointerDown: string; readonly hrefAtClick: string; readonly visible: boolean } | null;
  /** New contexts already opened during this gesture. */
  readonly openedCount: number;
}

export interface PopupRequest {
  /** `window.open`, a script-made click on a link, or a trusted click on an `a[target=_blank]`. */
  readonly kind: 'open' | 'synthetic-click' | 'link-click';
  readonly target: 'new-context' | 'same-tab' | 'existing-frame';
  /** The destination exactly as the page passed it. */
  readonly url: string;
  readonly pageUrl: string;
  readonly at: number;
}

export interface Judgement {
  readonly verdict: 'allow' | 'block';
  readonly rule: RuleCode;
  /** G7: neutralise the overlay (`pointer-events:none`, then hidden for the page lifetime). */
  readonly neutraliseOverlay?: true;
}

const EMPTY_ALLOWLIST: CompiledAllowlist = {};
const UNKNOWN_SCHEMES = /^(?:about|data|javascript):/i;
const BLOB = /^blob:/i;

/**
 * The destination as an http(s) URL, or `null` when it is unknown. Relative URLs resolve against the page.
 * A `blob:` URL counts as its inner http(s) origin (design review, P2-58: a page's own generated tab is same-site;
 * a third-party frame's blob is not); `blob:null`, a nested `blob:` and other opaque forms stay unknown.
 */
export function destinationOf(url: string, pageUrl: string): URL | null {
  const text = url.trim();
  if (BLOB.test(text)) {
    const inner = text.slice('blob:'.length);
    return BLOB.test(inner) ? null : destinationOf(inner, 'about:blank');
  }
  if (text === '' || UNKNOWN_SCHEMES.test(text)) return null;
  try {
    const parsed = new URL(url, pageUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
  } catch {
    return null;
  }
}

/** A link's `href` as a destination; fragment-only and `javascript:` links count as no link. */
const linkTarget = (href: string, pageUrl: string): URL | null => (href.startsWith('#') ? null : destinationOf(href, pageUrl));

/** Same site, with an unknown side counting as cross-site. */
const sameSite = (a: URL | null, b: URL | null): boolean => a !== null && b !== null && isSameSite(a.hostname, b.hostname);

const allow = (rule: RuleCode): Judgement => ({ verdict: 'allow', rule });
const block = (rule: RuleCode): Judgement => ({ verdict: 'block', rule });
/** Rows where the modes differ: Smart allows, Strict blocks. */
const byMode = (rule: RuleCode, mode: GuardMode): Judgement => (mode === 'strict' ? block(rule) : allow(rule));

interface Signals {
  readonly gesture: Gesture;
  readonly request: PopupRequest;
  readonly dest: URL | null;
  readonly mode: GuardMode;
}

/** G8–G10: the gesture's link and what the request does with it. */
function judgeLink(s: Signals): Judgement | null {
  const link = s.gesture.link;
  if (link === null) return null;
  const down = linkTarget(link.hrefAtPointerDown, s.request.pageUrl);
  if (down === null) return null;
  const click = linkTarget(link.hrefAtClick, s.request.pageUrl);
  const ownNavigation = s.request.kind === 'link-click' && link.visible && link.hrefAtPointerDown === link.hrefAtClick && s.dest?.href === click?.href;
  if (ownNavigation) return byMode('G8', s.mode);
  if (!sameSite(s.dest, down)) return block('G9');
  return sameSite(click, down) ? null : block('G10');
}

/** G6–G13 for a request made under a live gesture. */
function judgeGesture(s: Signals): Judgement {
  if (s.gesture.openedCount > 0) return block('G6');
  if (s.gesture.targetIsOverlay) return { verdict: 'block', rule: 'G7', neutraliseOverlay: true };
  const byLink = judgeLink(s);
  if (byLink !== null) return byLink;
  if (!s.gesture.targetInteractive) return block('G11');
  return byMode('G13', s.mode);
}

/** Decides one request (pop-up notes §7.3). `allowlist` is the compiled provider list of §8 (G5). */
export function judge(gesture: Gesture | null, request: PopupRequest, mode: GuardMode, allowlist: CompiledAllowlist = EMPTY_ALLOWLIST): Judgement {
  if (mode === 'off') return allow('G1');
  if (request.target !== 'new-context') return allow('G2');
  const live = gesture !== null && request.at - gesture.at <= GESTURE_WINDOW_MS ? gesture : null;
  if (live?.modifier === true) return allow('G3');
  const dest = destinationOf(request.url, request.pageUrl);
  if (sameSite(dest, destinationOf(request.pageUrl, request.pageUrl))) return allow('G4');
  if (dest !== null && matchesAllowlist(allowlist, dest)) return allow('G5');
  if (live === null) return byMode('G12', mode);
  return judgeGesture({ gesture: live, request, dest, mode });
}
