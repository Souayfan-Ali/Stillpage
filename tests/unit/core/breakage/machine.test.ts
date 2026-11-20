import { describe, expect, test } from 'vitest';
import type { Hostname } from '../../../../src/core/ids.js';
import { LADDERS, PAUSE_TRIAL_MS } from '../../../../src/core/breakage/ladders.js';
import { cancelFlow, markFixed, markStillBroken, offeredRemedies, openReport, startFlow, tryRemedy } from '../../../../src/core/breakage/machine.js';
import type { Availability, Remedy, SiteSnapshot, StartContext } from '../../../../src/core/breakage/types.js';

const NOW = 1_800_000_000_000;
const HOST = 'news.example.com' as Hostname;
const PLAIN: SiteSnapshot = { ownLevel: null, popupPolicy: null, pausedUntil: null };
const ctx = (over: Partial<StartContext> = {}): StartContext =>
  ({ tabId: 7, host: HOST, popupBlocked: false, availability: {}, now: NOW, ...over });

describe('ladders (UI notes §6)', () => {
  test.each([
    ['broken', [['allowPopups'], ['light'], ['off']]],
    ['adThrough', [['reload'], ['picker', 'thorough']]],
    ['antiAdblock', [['thorough'], ['pause']]],
  ] as const)('%s', (complaint, steps) => {
    expect(LADDERS[complaint]).toEqual(steps);
  });
});

describe('startFlow', () => {
  test('page broken without a blocked pop-up starts at Light (the pop-up step is skipped silently)', () => {
    const s = startFlow('broken', ctx()).state;
    expect(s).toMatchObject({ v: 1, tabId: 7, host: HOST, complaint: 'broken', step: 1, phase: 'offer', trial: null, updatedAt: NOW });
    expect(s.outcomes).toEqual([]);
  });

  test('page broken after a blocked pop-up starts with "Allow pop-ups on this site"', () => {
    expect(startFlow('broken', ctx({ popupBlocked: true })).state.step).toBe(0);
  });

  test('unavailable steps are skipped and recorded with their reason', () => {
    const s = startFlow('antiAdblock', ctx({ availability: { thorough: 'needs-site-access' } })).state;
    expect(s.step).toBe(1);
    expect(s.outcomes).toEqual([{ remedy: 'thorough', result: 'skipped', reason: 'needs-site-access' }]);
  });

  test('every step unavailable → straight to Report', () => {
    const availability: Partial<Record<Remedy, Availability>> = { light: 'noop', off: 'noop' };
    const s = startFlow('broken', ctx({ availability })).state;
    expect(s.phase).toBe('report');
    expect(s.outcomes.map((o) => o.reason)).toEqual(['noop', 'noop']);
  });
});

describe('tryRemedy', () => {
  test.each([
    ['broken', 'light', { kind: 'siteLevel', host: HOST, level: 'light' }],
    ['broken', 'off', { kind: 'siteLevel', host: HOST, level: 'off' }],
    ['antiAdblock', 'thorough', { kind: 'siteLevel', host: HOST, level: 'thorough' }],
    ['antiAdblock', 'pause', { kind: 'pause', host: HOST, until: NOW + 1 + PAUSE_TRIAL_MS }],
  ] as const)('%s / %s applies a settings change and reloads', (complaint, remedy, change) => {
    const start = startFlow(complaint, ctx({ popupBlocked: false })).state;
    const atStep = { ...start, step: LADDERS[complaint].findIndex((o) => o.includes(remedy)) };
    const t = tryRemedy(atStep, remedy, PLAIN, NOW + 1);
    expect(t.effects).toEqual([{ type: 'apply', change }, { type: 'reload' }]);
    expect(t.state).toMatchObject({ phase: 'await', updatedAt: NOW + 1, trial: { remedy, applied: change } });
  });

  test('allow pop-ups records the previous policy as the inverse', () => {
    const s = startFlow('broken', ctx({ popupBlocked: true })).state;
    const t = tryRemedy(s, 'allowPopups', { ...PLAIN, popupPolicy: 'strict' }, NOW);
    expect(t.effects[0]).toEqual({ type: 'apply', change: { kind: 'popupPolicy', host: HOST, policy: 'allow' } });
    expect(t.state.trial?.previous).toEqual({ kind: 'popupPolicy', host: HOST, policy: 'strict' });
  });

  test('the inverse of a level trial is the host’s own previous level, or inherit', () => {
    const s = startFlow('broken', ctx()).state;
    expect(tryRemedy(s, 'light', PLAIN, NOW).state.trial?.previous).toEqual({ kind: 'siteLevel', host: HOST, level: 'inherit' });
    expect(tryRemedy(s, 'light', { ...PLAIN, ownLevel: 'thorough' }, NOW).state.trial?.previous).toEqual({ kind: 'siteLevel', host: HOST, level: 'thorough' });
  });

  test('reload and the picker have no inverse', () => {
    const s = startFlow('adThrough', ctx()).state;
    const r = tryRemedy(s, 'reload', PLAIN, NOW);
    expect(r.effects).toEqual([{ type: 'reload' }]);
    expect(r.state.trial).toEqual({ remedy: 'reload', applied: null, previous: null });
    const p = tryRemedy({ ...s, step: 1 }, 'picker', PLAIN, NOW);
    expect(p.effects).toEqual([{ type: 'openPicker' }]);
  });

  test('a remedy that is not offered at this step is refused (state unchanged, no effect)', () => {
    const s = startFlow('broken', ctx()).state;
    expect(tryRemedy(s, 'off', PLAIN, NOW)).toEqual({ state: s, effects: [] });
    const waiting = tryRemedy(s, 'light', PLAIN, NOW).state;
    expect(tryRemedy(waiting, 'light', PLAIN, NOW)).toEqual({ state: waiting, effects: [] });
  });
});

describe('markStillBroken', () => {
  test('page broken: Light failed → reverted, Off offered from the original level', () => {
    const s = tryRemedy(startFlow('broken', ctx()).state, 'light', PLAIN, NOW).state;
    const t = markStillBroken(s, { ...PLAIN, ownLevel: 'light' }, {}, NOW + 5);
    expect(t.effects).toEqual([{ type: 'apply', change: { kind: 'siteLevel', host: HOST, level: 'inherit' } }]);
    expect(t.state).toMatchObject({ step: 2, phase: 'offer', trial: null, updatedAt: NOW + 5 });
    expect(t.state.outcomes).toEqual([{ remedy: 'light', result: 'still-broken', revert: 'reverted' }]);
  });

  test('compare-and-revert: a setting changed since the trial is left alone', () => {
    const s = tryRemedy(startFlow('broken', ctx()).state, 'light', PLAIN, NOW).state;
    const t = markStillBroken(s, { ...PLAIN, ownLevel: 'standard' }, {}, NOW);
    expect(t.effects).toEqual([]);
    expect(t.state.outcomes[0]).toEqual({ remedy: 'light', result: 'still-broken', revert: 'revert-skipped' });
  });

  test('pause trial reverted only while the same pause is still set', () => {
    const s = tryRemedy({ ...startFlow('antiAdblock', ctx()).state, step: 1 }, 'pause', PLAIN, NOW).state;
    const kept = markStillBroken(s, { ...PLAIN, pausedUntil: NOW + PAUSE_TRIAL_MS }, {}, NOW);
    expect(kept.effects).toEqual([{ type: 'apply', change: { kind: 'pause', host: HOST, until: null } }]);
    expect(markStillBroken(s, PLAIN, {}, NOW).effects).toEqual([]);
  });

  test('ad got through, step 2: the untried option stays offered; Report after both', () => {
    const s1 = markStillBroken(tryRemedy(startFlow('adThrough', ctx()).state, 'reload', PLAIN, NOW).state, PLAIN, {}, NOW).state;
    expect(s1).toMatchObject({ step: 1, phase: 'offer' });
    expect(s1.outcomes).toEqual([{ remedy: 'reload', result: 'still-broken' }]);
    const s2 = markStillBroken(tryRemedy(s1, 'thorough', PLAIN, NOW).state, { ...PLAIN, ownLevel: 'thorough' }, {}, NOW).state;
    expect(s2).toMatchObject({ step: 1, phase: 'offer' });
    expect(offeredRemedies(s2)).toEqual(['picker']);
    expect(offeredRemedies(tryRemedy(s2, 'picker', PLAIN, NOW).state)).toEqual([]);
    expect(tryRemedy(s2, 'thorough', PLAIN, NOW).effects).toEqual([]);
    const s3 = markStillBroken(tryRemedy(s2, 'picker', PLAIN, NOW).state, PLAIN, {}, NOW).state;
    expect(s3.phase).toBe('report');
  });

  test('an option that became unavailable is skipped when moving on', () => {
    const s1 = markStillBroken(tryRemedy(startFlow('adThrough', ctx()).state, 'reload', PLAIN, NOW).state, PLAIN, {}, NOW).state;
    const s2 = markStillBroken(tryRemedy(s1, 'picker', PLAIN, NOW).state, PLAIN, { thorough: 'capped-by-parent' }, NOW).state;
    expect(s2.phase).toBe('report');
    expect(s2.outcomes.at(-1)).toEqual({ remedy: 'thorough', result: 'skipped', reason: 'capped-by-parent' });
  });

  test('page broken, full ladder: pop-ups → Light → Off → Report', () => {
    let s = startFlow('broken', ctx({ popupBlocked: true })).state;
    const steps: [Remedy, SiteSnapshot][] = [['allowPopups', { ...PLAIN, popupPolicy: 'allow' }], ['light', { ...PLAIN, ownLevel: 'light' }], ['off', { ...PLAIN, ownLevel: 'off' }]];
    for (const [remedy, after] of steps) s = markStillBroken(tryRemedy(s, remedy, PLAIN, NOW).state, after, {}, NOW).state;
    expect(s.phase).toBe('report');
    expect(s.outcomes.map((o) => [o.remedy, o.revert])).toEqual([['allowPopups', 'reverted'], ['light', 'reverted'], ['off', 'reverted']]);
  });

  test('without a pending trial it does nothing', () => {
    const s = startFlow('broken', ctx()).state;
    expect(markStillBroken(s, PLAIN, {}, NOW)).toEqual({ state: s, effects: [] });
  });
});

describe('markFixed, cancelFlow, openReport', () => {
  test('Fixed keeps the change and ends the flow (state deleted)', () => {
    const s = tryRemedy(startFlow('broken', ctx()).state, 'light', PLAIN, NOW).state;
    expect(markFixed(s)).toEqual({ state: null, effects: [{ type: 'clearState' }], fixedBy: 'light' });
    expect(markFixed(startFlow('broken', ctx()).state).fixedBy).toBeNull();
  });

  test('Cancel reverts a pending trial (compare-and-revert) and ends the flow', () => {
    const s = tryRemedy(startFlow('broken', ctx()).state, 'off', PLAIN, NOW);
    const pending = tryRemedy({ ...startFlow('broken', ctx()).state, step: 2 }, 'off', PLAIN, NOW).state;
    expect(s.effects).toEqual([]);
    expect(cancelFlow(pending, { ...PLAIN, ownLevel: 'off' })).toEqual({
      state: null, effects: [{ type: 'apply', change: { kind: 'siteLevel', host: HOST, level: 'inherit' } }, { type: 'clearState' }] });
    expect(cancelFlow(pending, PLAIN).effects).toEqual([{ type: 'clearState' }]);
  });

  test('Report is reachable from any step and summarises what was tried', () => {
    const s = markStillBroken(tryRemedy(startFlow('broken', ctx()).state, 'light', PLAIN, NOW).state, { ...PLAIN, ownLevel: 'light' }, {}, NOW).state;
    const r = openReport(s, NOW + 9);
    expect(r.state).toMatchObject({ phase: 'report', updatedAt: NOW + 9 });
    expect(r.effects).toEqual([{ type: 'openReport', summary: { complaint: 'broken', host: HOST, outcomes: s.outcomes, fixedBy: null } }]);
  });
});
