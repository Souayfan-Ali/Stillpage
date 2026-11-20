/**
 * The `notify-gate` registration (P2-63, cosmetic notes §6a): the MAIN-world notification-prompt gate, present only
 * while the Notification prompts pack is on and fits (Q-24: never by default). Every frame of every page,
 * minus Off, Light and paused subtrees (Light is network-only, ADR-015). `matches` never depends on grants.
 */
import type { PackId } from '../ids.js';
import { rootsAtOrBelow } from '../levels/roots.js';
import type { EpochMs, Settings } from '../state/types.js';
import { hostPattern } from './registrations.js';
import type { ScriptRegistration } from './types.js';

/** Packaged MAIN-world script (WXT unlisted, `src/entrypoints/notify-gate.ts`). */
export const NOTIFY_GATE_SCRIPT = 'notify-gate.js';
/** The Notification prompts pack (lists.config.json). */
const NOTIFY_PACK = 'annoy-notifications' as PackId;

/** The registration, when `packs` (on and fitting) includes the Notification prompts pack. */
export function notifyGateRegistrations(settings: Settings, now: EpochMs, packs: readonly PackId[]): readonly ScriptRegistration[] {
  if (!packs.includes(NOTIFY_PACK)) return [];
  return [{
    id: 'notify-gate',
    world: 'MAIN',
    js: [NOTIFY_GATE_SCRIPT],
    matches: ['<all_urls>'],
    excludeMatches: rootsAtOrBelow(settings, now, 'light').map(hostPattern).sort(),
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
  }];
}
