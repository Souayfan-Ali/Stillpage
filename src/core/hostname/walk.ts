/** Parent-domain walk (P1-03). Dependency-free. */
import type { Hostname } from '../ids.js';

/** The host itself, then each parent down to the last label: `a.b.com` → `a.b.com`, `b.com`, `com`. */
export function parentDomains(host: Hostname): readonly Hostname[] {
  const labels = host.split('.');
  return labels.map((_, i) => labels.slice(i).join('.') as Hostname);
}

/** True when `host` equals `parent` or is a subdomain of it (label-aligned, never a partial label). */
export function isSameOrSubdomain(host: Hostname, parent: Hostname): boolean {
  return host === parent || host.endsWith(`.${parent}`);
}
