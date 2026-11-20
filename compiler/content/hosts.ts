/**
 * Hosts of cosmetic and scriptlet filters → hosts that can be match patterns (`*://*.host/*`).
 * One invalid pattern fails a whole `registerContentScripts` call (S-04), so every host is checked
 * here: lower-case ASCII (IDN through punycode), a site host (never a suffix such as `com` or
 * `co.uk`, never an IP literal), and entity forms by observed expansion (D-20).
 */
import { domainToASCII } from 'node:url';
import type { Hostname } from '../../src/core/ids.js';
import { expandEntities, isEntity } from '../entities/expand.js';
import { isSiteHost } from '../entities/hosts.js';

export type HostOutcome =
  | { readonly hosts: readonly Hostname[] }
  | { readonly lost: string }
  | { readonly invalid: string };

/** `domain` of a filter's domain list → the hosts it stands for. */
export function resolveHost(domain: string, stems: ReadonlyMap<string, readonly string[]>): HostOutcome {
  if (isEntity(domain)) {
    const hosts = expandEntities([domain], stems).hosts.filter(isSiteHost);
    return hosts.length > 0 ? { hosts: hosts as Hostname[] } : { lost: domain };
  }
  const ascii = /^[\x20-\x7e]*$/.test(domain) ? domain.toLowerCase() : domainToASCII(domain);
  return isSiteHost(ascii) ? { hosts: [ascii as Hostname] } : { invalid: domain };
}

const MATCH_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Independent re-check of an emitted host (verify stage): Chrome's match-pattern host grammar plus site-ness. */
export const isPatternHost = (host: string): boolean => host.length <= 253 && MATCH_HOST.test(host) && isSiteHost(host);
