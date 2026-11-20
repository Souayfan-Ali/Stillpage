/**
 * Off and pause as `allowAllRequests` rules (architecture notes §4, §10): the minimal Off roots, coalesced into
 * a handful of rules in the site-state id realm at the Off priority. `requestDomains` matches
 * subdomains, so a root covers its subtree, which is exact because Off cannot be overridden.
 */
import { rootsAtOrBelow } from '../levels/roots.js';
import { DYNAMIC_ID_REALMS, OFF_PRIORITY } from '../limits.js';
import type { EpochMs, Settings } from '../state/types.js';
import type { DnrRule } from './types.js';

/** Hosts per `allowAllRequests` rule; 1,000 sites per level + pauses fit in well under 100 rules. */
const OFF_HOSTS_PER_RULE = 100;

/** The site-state rules for `settings` at `now`, ids from the start of the realm. */
export function siteStateRules(settings: Settings, now: EpochMs): readonly DnrRule[] {
  const hosts = rootsAtOrBelow(settings, now, 'off');
  const chunks = Array.from({ length: Math.ceil(hosts.length / OFF_HOSTS_PER_RULE) }, (_, i) =>
    hosts.slice(i * OFF_HOSTS_PER_RULE, (i + 1) * OFF_HOSTS_PER_RULE),
  );
  return chunks.map((requestDomains, i) => ({
    id: DYNAMIC_ID_REALMS.siteState.min + i,
    priority: OFF_PRIORITY,
    action: { type: 'allowAllRequests' },
    condition: { requestDomains, resourceTypes: ['main_frame'] },
  }));
}
