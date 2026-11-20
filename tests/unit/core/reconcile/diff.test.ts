import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { applyPlan } from '../../../../src/core/reconcile/apply.js';
import { computeDesired } from '../../../../src/core/reconcile/computeDesired.js';
import { diff, isEmptyPlan } from '../../../../src/core/reconcile/diff.js';
import type { ActualState, Plan } from '../../../../src/core/reconcile/plan.js';
import type { DnrRule, ScriptRegistration } from '../../../../src/core/reconcile/types.js';
import type { RulesetId } from '../../../../src/core/ids.js';
import { GRANTS, NOW, settings, testCatalog } from './fixtures.js';
import { OFF_PRIORITY } from '../../../../src/core/limits.js';

const EMPTY_ACTUAL: ActualState = { enabledRulesets: [], dynamicRules: [], sessionRules: [], contentScripts: [] };

const offRule = (id: number, hosts: string[], priority: number = OFF_PRIORITY): DnrRule => ({
  id,
  priority,
  action: { type: 'allowAllRequests' },
  condition: { requestDomains: hosts, resourceTypes: ['main_frame'] },
});

const registration = (id: string, hosts: string[]): ScriptRegistration => ({
  id,
  world: 'ISOLATED',
  js: [`cs/${id}.js`],
  matches: hosts.map((h) => `*://*.${h}/*`),
  excludeMatches: [],
  runAt: 'document_start',
  allFrames: true,
  matchOriginAsFallback: true,
  persistAcrossSessions: true,
});

const rid = (...ids: string[]): RulesetId[] => ids as RulesetId[];

function desiredFrom(actual: ActualState): Parameters<typeof diff>[0] {
  return { ...actual, skippedPacks: [], hasAllSitesAccess: true };
}

describe('diff: minimal plans', () => {
  test('equal states give an empty plan', () => {
    const state = computeDesired(settings({ siteLevels: { 'example.com': 'off' } }), GRANTS.allSites, testCatalog(), NOW);
    const actual: ActualState = state;

    expect(isEmptyPlan(diff(state, actual))).toBe(true);
  });

  test('order of the actual lists does not matter', () => {
    const actual: ActualState = {
      enabledRulesets: rid('b', 'a'),
      dynamicRules: [offRule(2, ['b.com']), offRule(1, ['a.com'])],
      sessionRules: [],
      contentScripts: [registration('z', ['z.com']), registration('a', ['a.com'])],
    };
    const desired = desiredFrom({
      enabledRulesets: rid('a', 'b'),
      dynamicRules: [offRule(1, ['a.com']), offRule(2, ['b.com'])],
      sessionRules: [],
      contentScripts: [registration('a', ['a.com']), registration('z', ['z.com'])],
    });

    expect(isEmptyPlan(diff(desired, actual))).toBe(true);
  });

  test('Chrome returns match patterns in its own order: a reordered pattern list is not drift (P1-35)', () => {
    const want = registration('iso:ads:1', ['a.b', 'a.b-c']);
    const got = { ...want, matches: [...want.matches].reverse(), excludeMatches: [] };
    const desired = { ...computeDesired(settings(), GRANTS.allSites, testCatalog(), NOW), contentScripts: [want] };
    const plan = diff(desired, { ...desired, contentScripts: [got] });
    expect(plan.scripts).toEqual({ register: [], update: [], unregister: [] });
  });

  test('an Off or Light change updates only the shard registrations that hold the host (P1-35)', () => {
    const before = computeDesired(settings(), GRANTS.allSites, testCatalog(), NOW);
    const holding = before.contentScripts.filter((r) => r.matches.includes('*://*.news.org/*')).map((r) => r.id);
    for (const level of ['off', 'light'] as const) {
      const after = computeDesired(settings({ siteLevels: { 'news.org': level } }), GRANTS.allSites, testCatalog(), NOW);
      const plan = diff(after, before);
      expect([...plan.scripts.update.map((r) => r.id), ...plan.scripts.unregister].sort()).toEqual([...holding].sort());
      expect(plan.scripts.register).toEqual([]);
    }
    expect(holding.length).toBeLessThan(before.contentScripts.length);
  });

  test('enables and disables only the rulesets that differ', () => {
    const plan = diff(desiredFrom({ ...EMPTY_ACTUAL, enabledRulesets: rid('a', 'c') }), {
      ...EMPTY_ACTUAL,
      enabledRulesets: rid('a', 'b'),
    });

    expect(plan.rulesets).toEqual({ enable: ['c'], disable: ['b'] });
  });

  test('replaces a changed dynamic rule and leaves equal ones alone, in one batch', () => {
    const actual = { ...EMPTY_ACTUAL, dynamicRules: [offRule(1, ['a.com']), offRule(2, ['b.com']), offRule(3, ['c.com'])] };
    const desired = desiredFrom({ ...EMPTY_ACTUAL, dynamicRules: [offRule(1, ['a.com']), offRule(2, ['x.com'])] });

    expect(diff(desired, actual).dynamicRules).toEqual({ removeRuleIds: [2, 3], addRules: [offRule(2, ['x.com'])] });
  });

  test('registers, updates and unregisters content scripts by id', () => {
    const actual = { ...EMPTY_ACTUAL, contentScripts: [registration('a', ['a.com']), registration('b', ['b.com'])] };
    const desired = desiredFrom({
      ...EMPTY_ACTUAL,
      contentScripts: [registration('a', ['a.com', 'a2.com']), registration('c', ['c.com'])],
    });

    expect(diff(desired, actual).scripts).toEqual({
      register: [registration('c', ['c.com'])],
      update: [registration('a', ['a.com', 'a2.com'])],
      unregister: ['b'],
    });
  });

  test('treats session rules like dynamic rules', () => {
    const plan = diff(desiredFrom({ ...EMPTY_ACTUAL, sessionRules: [offRule(5, ['s.com'])] }), EMPTY_ACTUAL);
    expect(plan.sessionRules).toEqual({ removeRuleIds: [], addRules: [offRule(5, ['s.com'])] });
  });

  test('compares rules by value, not by key order', () => {
    const reordered: DnrRule = {
      condition: { resourceTypes: ['main_frame'], requestDomains: ['a.com'] },
      action: { type: 'allowAllRequests' },
      priority: OFF_PRIORITY,
      id: 1,
    };
    const plan = diff(desiredFrom({ ...EMPTY_ACTUAL, dynamicRules: [offRule(1, ['a.com'])] }), {
      ...EMPTY_ACTUAL,
      dynamicRules: [reordered],
    });

    expect(isEmptyPlan(plan)).toBe(true);
  });
});

describe('diff then apply: property', () => {
  const host = fc.constantFrom('a.com', 'b.com', 'c.org', 'd.net');
  const rule = fc.record({ id: fc.integer({ min: 1, max: 8 }), hosts: fc.uniqueArray(host, { minLength: 1 }) });
  const rules = fc
    .uniqueArray(rule, { selector: (r) => r.id, maxLength: 6 })
    .map((list) => list.map((r) => offRule(r.id, r.hosts)));
  const scripts = fc
    .uniqueArray(fc.record({ id: fc.constantFrom('s1', 's2', 's3', 's4'), hosts: fc.uniqueArray(host, { minLength: 1 }) }), {
      selector: (s) => s.id,
    })
    .map((list) => list.map((s) => registration(s.id, s.hosts)));
  const state = fc.record({
    enabledRulesets: fc.uniqueArray(fc.constantFrom(...rid('r1', 'r2', 'r3', 'r4-x'))),
    dynamicRules: rules,
    sessionRules: rules,
    contentScripts: scripts,
  });

  test('apply(actual, diff(desired, actual)) converges and a second diff is empty', () => {
    fc.assert(
      fc.property(state, state, (desiredState, actual) => {
        const desired = desiredFrom(desiredState);
        const plan: Plan = diff(desired, actual);
        const after = applyPlan(actual, plan);

        expect(isEmptyPlan(diff(desired, after))).toBe(true);
        expect(new Set(after.enabledRulesets)).toEqual(new Set(desired.enabledRulesets));
        expect(after.dynamicRules.map((r) => r.id).sort()).toEqual(desired.dynamicRules.map((r) => r.id).sort());
      }),
    );
  });

  test('a plan never touches what already matches', () => {
    fc.assert(
      fc.property(state, (s) => {
        expect(isEmptyPlan(diff(desiredFrom(s), s))).toBe(true);
      }),
    );
  });

  test('applyPlan does not modify the actual state', () => {
    const actual: ActualState = Object.freeze({ ...EMPTY_ACTUAL, enabledRulesets: Object.freeze(rid('a')) });
    expect(() => applyPlan(actual, diff(desiredFrom({ ...EMPTY_ACTUAL, enabledRulesets: rid('b') }), actual))).not.toThrow();
    expect(actual.enabledRulesets).toEqual(['a']);
  });
});

describe('diff: registration comparison covers every field', () => {
  const base = registration('iso:a:1', ['a.test']);
  test.each([
    ['world', { world: 'MAIN' }],
    ['js', { js: ['other.js'] }],
    ['matches', { matches: ['*://*.b.test/*'] }],
    ['excludeMatches', { excludeMatches: ['*://*.c.a.test/*'] }],
    ['runAt', { runAt: 'document_idle' }],
    ['allFrames', { allFrames: false }],
    ['matchOriginAsFallback', { matchOriginAsFallback: false }],
    ['persistAcrossSessions', { persistAcrossSessions: false }],
  ])('a different %s is an update', (_field, change) => {
    const actual: ActualState = { ...EMPTY_ACTUAL, contentScripts: [{ ...base, ...change } as ScriptRegistration] };
    expect(diff(desiredFrom({ ...EMPTY_ACTUAL, contentScripts: [base] }), actual).scripts.update).toEqual([base]);
  });
});

describe('re-band migration (design review, 24-bit priorities)', () => {
  test('a live Off rule with the old 30,000,000 priority and the same id is replaced by the 15,000,000 one', () => {
    const desired = computeDesired(settings({ siteLevels: { 'off.example': 'off' } }), GRANTS.allSites, testCatalog(), NOW);
    const fresh = desired.dynamicRules.find((r) => r.priority === OFF_PRIORITY);
    if (fresh === undefined) throw new Error('no Off rule');
    const stale = { ...fresh, priority: 30_000_000 };
    const plan = diff(desired, { ...EMPTY_ACTUAL, enabledRulesets: desired.enabledRulesets, dynamicRules: [stale] });
    expect(plan.dynamicRules.removeRuleIds).toContain(fresh.id);
    expect(plan.dynamicRules.addRules).toContainEqual(fresh);
  });
});
