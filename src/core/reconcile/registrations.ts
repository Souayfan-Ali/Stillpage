/**
 * Shard registrations from catalog templates (architecture notes §9). Registrations never depend on grants:
 * Chrome skips injection where access is missing (S-10). Levels decide the patterns:
 * - Off / Light subtrees are removed: a filter host inside one is dropped from `matches`, a root
 *   inside a filter host's subtree goes into `excludeMatches`.
 * - With a Light default, only subtrees explicitly raised to Standard or above are matched.
 */
import type { CatalogRegistration } from '../catalog/registrations.js';
import { isSameOrSubdomain } from '../hostname/walk.js';
import type { Hostname } from '../ids.js';
import type { ScriptRegistration } from './types.js';

/** Where shard scripts may run: everywhere, or only inside these subtrees. */
export type Scope = 'everywhere' | readonly Hostname[];

const IPV4 = /^\d+(?:\.\d+){3}$/;

/** One pattern per host: `*://*.host/*` (also matches the host itself); IPv4 has no subdomains. */
export function hostPattern(host: Hostname): string {
  return IPV4.test(host) ? `*://${host}/*` : `*://*.${host}/*`;
}

function scopedHosts(hosts: readonly Hostname[], scope: Scope): readonly Hostname[] {
  if (scope === 'everywhere') return hosts;
  const narrowed = hosts.flatMap((host) =>
    scope.flatMap((root) => {
      if (isSameOrSubdomain(host, root)) return [host];
      return isSameOrSubdomain(root, host) ? [root] : [];
    }),
  );
  return [...new Set(narrowed)];
}

/** The registration for one template, or `null` when no host is left to match. */
export function toRegistration(
  template: CatalogRegistration,
  scope: Scope,
  lowered: readonly Hostname[],
): ScriptRegistration | null {
  const kept = scopedHosts(template.hosts, scope).filter(
    (host) => !lowered.some((root) => isSameOrSubdomain(host, root)),
  );
  if (kept.length === 0) return null;
  const excluded = lowered.filter((root) => kept.some((host) => root !== host && isSameOrSubdomain(root, host)));
  return {
    id: template.id,
    world: template.world,
    js: [...template.js],
    // Sorted as pattern strings, the order Chrome reports them in (`*.a.b-c` before `*.a.b`).
    matches: kept.map(hostPattern).sort(),
    excludeMatches: excluded.map(hostPattern).sort(),
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
  };
}
