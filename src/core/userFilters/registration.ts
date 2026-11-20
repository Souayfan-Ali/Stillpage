/**
 * The `user-cosmetic` registration (P2-20, architecture notes §9; design review): ISOLATED, `document_start`, all frames,
 * on every host with filters (`*://*.H/*`, `*://H/*` for an IP), excluded under Off and paused
 * subtrees but **not** under Light: a filter is the user's explicit choice for that site.
 */
import { rootsAtOrBelow } from '../levels/roots.js';
import type { Hostname } from '../ids.js';
import { toRegistration } from '../reconcile/registrations.js';
import type { ScriptRegistration } from '../reconcile/types.js';
import type { EpochMs, Settings } from '../state/types.js';

const USER_COSMETIC_ID = 'user-cosmetic';
const USER_COSMETIC_SCRIPT = 'user-cosmetic.js';

export function userCosmeticRegistration(hosts: readonly Hostname[], settings: Settings, now: EpochMs): ScriptRegistration | null {
  if (hosts.length === 0) return null;
  return toRegistration({ id: USER_COSMETIC_ID, world: 'ISOLATED', js: [USER_COSMETIC_SCRIPT], hosts: [...hosts] }, 'everywhere', rootsAtOrBelow(settings, now, 'off'));
}
