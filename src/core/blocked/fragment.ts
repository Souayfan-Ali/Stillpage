/**
 * The blocked page's input (P2-55, pop-up notes §6.2): the redirect rule appends the original address as
 * the fragment (`blocked.html#<url>`). A page can open `blocked.html#<anything>`, so the fragment is
 * hostile input: only an absolute http(s) URL without credentials, of bounded length, whose host is a
 * plain hostname, is accepted. The host is shown with `textContent` only and the address never is.
 */
import { parseHostname } from '../hostname/validate.js';
import type { Hostname } from '../ids.js';

/** Longest fragment accepted (Chrome's own URL limit is far larger; ours is a display page). */
export const MAX_FRAGMENT_LENGTH = 8_192;
const WEB_SCHEME = /^https?:\/\//i;

export interface BlockedTarget {
  /** Canonical address (`URL.href`), used only for "Proceed once". */
  readonly url: string;
  readonly host: Hostname;
}

function webUrl(text: string): URL | null {
  if (!WEB_SCHEME.test(text)) return null;
  try {
    const u = new URL(text);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === '' ? u : null;
  } catch {
    return null;
  }
}

/** The blocked address from `location.hash`, or `null` when it is not a plain web address. */
export function parseBlockedFragment(hash: string): BlockedTarget | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (text.length === 0 || text.length > MAX_FRAGMENT_LENGTH) return null;
  const u = webUrl(text);
  const host = u === null ? null : parseHostname(u.hostname);
  return u === null || host === null || host !== u.hostname ? null : { url: u.href, host };
}

/** Hostname of the page that sent the tab here (`document.referrer`), or `null`. */
export function senderHost(referrer: string): Hostname | null {
  const u = webUrl(referrer);
  const host = u === null ? null : parseHostname(u.hostname);
  return host !== null && host === u?.hostname ? host : null;
}
