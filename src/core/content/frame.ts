/**
 * The host a content script looks up (cosmetic notes §2.2): the frame's own hostname, else the host of its
 * origin (`blob:` frames), else the parent's origin (`about:blank` and `srcdoc` frames reached through
 * `matchOriginAsFallback`). Pure and dependency-free: content scripts import it.
 */
import type { Hostname } from '../ids.js';
import { parseHostname } from '../hostname/validate.js';

/** The parts of `Location` this needs; `ancestorOrigins` is Chrome's (closest ancestor first). */
export interface FrameLocation {
  readonly hostname: string;
  readonly origin: string;
  readonly ancestorOrigins?: { readonly length: number; readonly [index: number]: string };
}

function hostOf(origin: string | undefined): string {
  if (origin === undefined || origin === 'null') return '';
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

/** The lookup host of a frame, or `null` when none is usable. */
export function frameHost(location: FrameLocation): Hostname | null {
  const candidates = [location.hostname, hostOf(location.origin), hostOf(location.ancestorOrigins?.[0])];
  const found = candidates.find((c) => c !== '');
  return found === undefined ? null : parseHostname(found);
}
