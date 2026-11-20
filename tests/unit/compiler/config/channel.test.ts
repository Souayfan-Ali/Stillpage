/**
 * P2-29 (D-16, design review 2026-11-14): owner-pending packs are built and tested in the dev channel; a public
 * build fails while any shipped pack is owner-pending; removing the pending packs is a config transform
 * that drops their rulesets (36 → 32 slots). The store-ready zip is built with that transform.
 */
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { channelProblems, pendingPacks, withoutPendingPacks } from '../../../../compiler/config/channel.js';
import { loadListsConfig } from '../../../../compiler/config/load.js';
import { ceilingProblems, slotsOf } from '../../../../compiler/postpass/budgets.js';
import { RULESET_SLOTS } from '../../../../src/core/limits.js';

const CONFIG_FILE = path.resolve(import.meta.dirname, '../../../../lists/lists.config.json');

/** A valid tracker, so these cases test the packs alone. */
const TRACKER = 'https://github.com/owner/repo';

describe('release channel and owner-pending packs', () => {
  test('zh and es/pt are the pending packs; the dev channel builds them, the public channel refuses', async () => {
    const config = await loadListsConfig(CONFIG_FILE);
    expect(pendingPacks(config)).toEqual(['reg-zh', 'reg-es-pt']);
    expect(channelProblems(config, 'dev')).toEqual([]);
    expect(channelProblems(config, 'public', TRACKER)).toEqual(['owner-pending pack(s) in a public build: reg-zh, reg-es-pt (D-16; build with --drop-pending)']);
  });

  test('a public build fails while ISSUE_TRACKER_URL is the placeholder (Q-11); dev builds do not care', async () => {
    const store = withoutPendingPacks(await loadListsConfig(CONFIG_FILE));
    expect(channelProblems(store, 'public', 'https://github.com/OWNER/REPO-PLACEHOLDER')).toEqual([expect.stringContaining('ISSUE_TRACKER_URL is the placeholder')]);
    expect(channelProblems(store, 'public', 'https://github.com/owner/repo/')).toHaveLength(1);
    expect(channelProblems(store, 'public', TRACKER)).toEqual([]);
    expect(channelProblems(store, 'dev')).toEqual([]);
  });

  test('the shipped tracker (D-88) lets a public store build through', async () => {
    const store = withoutPendingPacks(await loadListsConfig(CONFIG_FILE));
    expect(channelProblems(store, 'public')).toEqual([]);
  });

  test('dropping the pending packs is a config change: 36 → 32 slots, no pending list left, every gate still holds', async () => {
    const config = await loadListsConfig(CONFIG_FILE);
    const store = withoutPendingPacks(config);
    expect(slotsOf(config)).toHaveLength(RULESET_SLOTS);
    expect(slotsOf(store)).toHaveLength(32);
    expect(Object.keys(store.packs)).not.toEqual(expect.arrayContaining(['reg-zh']));
    expect(store.lists.some((l) => l.licenceState === 'owner-pending')).toBe(false);
    expect(channelProblems(store, 'public', TRACKER)).toEqual([]);
    expect(ceilingProblems(slotsOf(store), 32)).toEqual([]);
    expect(config.rulesets.some((r) => r.id === 'reg-zh')).toBe(true);
  });
});
