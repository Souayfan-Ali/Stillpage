/**
 * Release channels and owner-pending packs (P2-29, D-16; design review 2026-11-14). A pack is pending when any
 * of its lists is `owner-pending`. The dev channel builds and tests every pack; a public build fails
 * while one is shipped; `withoutPendingPacks` removes them (with their rulesets and lists) before the
 * compile, which is how the store-ready zip is built until the owner clears them.
 */
import { ISSUE_TRACKER_URL, trackerOf } from '../../src/core/tracker.js';
import type { ListsConfig } from './schema.js';

export type Channel = 'dev' | 'public';

/** Packs with an owner-pending list, in ruleset order. */
export function pendingPacks(config: ListsConfig): readonly string[] {
  const pending = new Set(config.lists.filter((l) => l.licenceState === 'owner-pending').map((l) => l.id));
  return [...new Set(config.rulesets.filter((r) => r.lists.some((id) => pending.has(id))).map((r) => r.pack))];
}

/**
 * Why `config` may not be built for `channel` (empty when it may). A public build also needs a real
 * issue tracker (Q-11): while `ISSUE_TRACKER_URL` is the placeholder, "Send report" can only copy.
 */
export function channelProblems(config: ListsConfig, channel: Channel, trackerUrl: string = ISSUE_TRACKER_URL): readonly string[] {
  if (channel === 'dev') return [];
  const pending = pendingPacks(config);
  return [
    ...(pending.length === 0 ? [] : [`owner-pending pack(s) in a public build: ${pending.join(', ')} (D-16; build with --drop-pending)`]),
    ...(trackerOf(trackerUrl) === null ? ['ISSUE_TRACKER_URL is the placeholder (Q-11): set src/core/tracker.ts to https://github.com/<owner>/<repo> before a public build'] : []),
  ];
}

/** `config` without its pending packs, their rulesets and their lists. Returns a new object. */
export function withoutPendingPacks(config: ListsConfig): ListsConfig {
  const drop = new Set(pendingPacks(config));
  const rulesets = config.rulesets.filter((r) => !drop.has(r.pack));
  const kept = new Set(rulesets.flatMap((r) => r.lists));
  return {
    ...config,
    packs: Object.fromEntries(Object.entries(config.packs).filter(([id]) => !drop.has(id))),
    rulesets,
    lists: config.lists.filter((l) => kept.has(l.id)),
  };
}
