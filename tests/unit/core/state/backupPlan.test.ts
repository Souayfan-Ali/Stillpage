import { describe, expect, test } from 'vitest';
import type { PackId } from '../../../../src/core/ids.js';
import type { SkippedPack } from '../../../../src/core/reconcile/types.js';
import type { BackupSettings } from '../../../../src/core/state/backup.js';
import { changesOf, hiddenChange, type PackInfo } from '../../../../src/core/state/backupChanges.js';
import { planRestore } from '../../../../src/core/state/backupPlan.js';
import type { Settings } from '../../../../src/core/state/types.js';
import { settings, testCatalog } from '../reconcile/fixtures.js';

const portable = (s: Settings): BackupSettings => ({
  defaultLevel: s.defaultLevel,
  siteLevels: s.siteLevels,
  packs: s.packs,
  cookieBanners: s.cookieBanners,
  popups: s.popups,
  gpc: s.gpc,
  ui: s.ui,
});
const none = (): readonly SkippedPack[] => [];
/** The page's pack rows for the test catalog (ids, defaults, toggleable). */
const PACKS: readonly PackInfo[] = [
  { id: 'ads', default: true, toggleable: true },
  { id: 'trackers', default: true, toggleable: true },
  { id: 'cookies', default: false, toggleable: true },
  { id: 'popups', default: true, toggleable: false },
];
const previewOf = (current: Settings, plan: { settings: Settings; dropped: readonly unknown[] }) => ({ changes: changesOf(current, plan.settings, PACKS), dropped: plan.dropped });

describe('restore plan (P2-37)', () => {
  test('identical settings: no changes, nothing dropped', () => {
    const current = settings({ siteLevels: { 'a.example': 'off' } });
    const plan = planRestore(current, portable(current), testCatalog(), none);
    expect(previewOf(current, plan)).toEqual({ changes: [], dropped: [] });
    expect(plan.settings).toEqual(current);
  });

  test('lists every kind of change in dashboard order', () => {
    const current = settings({ siteLevels: { 'a.example': 'off', 'b.example': 'light', 'c.example': 'light' } });
    const next: Settings = {
      ...settings({ defaultLevel: 'thorough', cookieBanners: 'hide', siteLevels: { 'b.example': 'thorough', 'c.example': 'light', 'd.example': 'off' } }),
      packs: { trackers: false } as Settings['packs'],
      popups: { mode: 'strict', sites: { 'pay.example': 'allow' } as Settings['popups']['sites'], notice: false },
      gpc: true,
      ui: { theme: 'dark', showBadge: false },
    };
    const preview = previewOf(current, planRestore(current, portable(next), testCatalog(), none));
    expect(preview.changes).toEqual([
      { kind: 'defaultLevel', from: 'standard', to: 'thorough' },
      { kind: 'pack', pack: 'trackers', to: false },
      { kind: 'pack', pack: 'cookies', to: true },
      { kind: 'siteLevels', added: 1, removed: 1, changed: 1, weakened: 1, weakenedHosts: ['d.example'] },
      { kind: 'popupMode', from: 'off', to: 'strict' },
      { kind: 'popupSites', added: 1, removed: 0, changed: 0, weakened: 1, weakenedHosts: ['pay.example'] },
      { kind: 'popupNotice', to: false },
      { kind: 'gpc', to: true },
      { kind: 'badge', to: false },
      { kind: 'theme', to: 'dark' },
    ]);
  });

  test('drops packs this build does not have or the user cannot toggle', () => {
    const current = settings();
    const backup = portable(settings({ packs: { 'reg-xx': true, popups: false, cookies: true } }));
    const plan = planRestore(current, backup, testCatalog(), none);
    expect(plan.dropped).toEqual([
      { pack: 'reg-xx', reason: 'unavailable' },
      { pack: 'popups', reason: 'not-toggleable' },
    ]);
    expect(plan.settings.packs).toEqual({ cookies: true });
  });

  test('drops a pack that does not fit now, so it is not stored', () => {
    const current = settings();
    const backup = portable(settings({ cookieBanners: 'hide' }));
    const skippedOf = (s: Settings): readonly SkippedPack[] =>
      s.cookieBanners === 'hide' ? [{ pack: 'cookies' as PackId, reason: 'rule-pool', needed: 2000, available: 10 }] : [];
    const plan = planRestore(current, backup, testCatalog(), skippedOf);
    expect(plan.dropped).toEqual([{ pack: 'cookies', reason: 'rule-pool' }]);
    expect(plan.settings.cookieBanners).toBe('leave');
    expect(changesOf(current, plan.settings, PACKS)).toEqual([]);
  });

  test('keeps local pauses and onboarding', () => {
    const current = { ...settings({ pauses: { 'x.example': 5 } }), onboarding: { completedAt: 3 } };
    const plan = planRestore(current, portable(settings()), testCatalog(), none);
    expect(plan.settings.pauses).toEqual(current.pauses);
    expect(plan.settings.onboarding).toEqual({ completedAt: 3 });
  });

  test('changesOf ignores packs that follow other settings', () => {
    expect(changesOf(settings(), settings({ packs: { popups: false } }), PACKS)).toEqual([]);
  });
});

describe('hidden items in the preview (P2-22)', () => {
  const hosts = (h: Record<string, string[]>) => h as Parameters<typeof hiddenChange>[0];

  test('counts filters added and removed (a host+selector pair is one item); null when nothing changes', () => {
    const before = hosts({ 'a.example': ['#a', '#b'], 'b.example': ['#c'] });
    const after = hosts({ 'a.example': ['#a', '#z'], 'c.example': ['#d'] });
    expect(hiddenChange(before, after)).toEqual({ kind: 'hidden', added: 2, removed: 2 });
    expect(hiddenChange(before, before)).toBeNull();
  });

  test('a file that empties the list removes everything', () => {
    expect(hiddenChange(hosts({ 'a.example': ['#a', '#b'] }), hosts({}))).toEqual({ kind: 'hidden', added: 0, removed: 2 });
  });
});
