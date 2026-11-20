/**
 * D-55 / D-55a: the lifted redirect group. Hosts of `popup-lifted.json` get their redirect at 5,000,000
 * only while one of their justifying rulesets and the `popups` ruleset are enabled and `<all_urls>` is
 * granted; everything else stays in the ordinary group at 2. Lifted Proceed once rules of hosts no longer
 * lifted are dropped. Both groups together stay within `POPUP_REALM_BUDGET.unsafe`.
 */
import { describe, expect, test } from 'vitest';
import { liftedProceedOnceRule, proceedOnceRule } from '../../../../src/core/blocked/proceed.js';
import type { Hostname } from '../../../../src/core/ids.js';
import { DYNAMIC_ID_REALMS, POPUP_LIFT_PRIORITY, POPUP_PRIORITY, dynamicRealmOf } from '../../../../src/core/limits.js';
import { computeDesired, DEFAULT_DESIRED_LIMITS } from '../../../../src/core/reconcile/computeDesired.js';
import { liftedHosts, POPUP_REALM_BUDGET, type PopupInputs } from '../../../../src/core/reconcile/popups.js';
import type { DnrRule, Grants } from '../../../../src/core/reconcile/types.js';
import type { Settings } from '../../../../src/core/state/types.js';
import { GRANTS, NOW, settings, testCatalog } from './fixtures.js';

const BLOCKED = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/blocked.html';
const h = (hosts: readonly string[]): readonly Hostname[] => hosts as readonly Hostname[];
const INPUTS: PopupInputs = {
  destinations: h(['a-ads.com', 'ads.example', 'pop.test', 'track.example']),
  lifted: { ubo: h(['a-ads.com']), easyprivacy: h(['track.example']), easylist: h(['pop.test']) },
  strictSites: h([]),
  blockedPageUrl: BLOCKED,
  guardShipped: true,
  listStrict: true,
};

const desired = (s: Settings, grants: Grants = GRANTS.allSites, inputs: PopupInputs = INPUTS, sessionRules: readonly DnrRule[] = []) =>
  computeDesired(s, grants, testCatalog(), NOW, DEFAULT_DESIRED_LIMITS, { popups: inputs, sessionRules });
const redirects = (rules: readonly DnrRule[]) => rules.filter((r) => dynamicRealmOf(r.id) === 'popupDestinations' && r.action.type === 'redirect');
const hostsAt = (rules: readonly DnrRule[], priority: number) => redirects(rules).filter((r) => r.priority === priority).flatMap((r) => r.condition.requestDomains ?? []);

describe('lifted redirect group', () => {
  test('lifts hosts whose justifying ruleset is enabled; the rest stay at 2 (easylist is not in this catalog)', () => {
    const rules = desired(settings()).dynamicRules;
    expect(hostsAt(rules, POPUP_LIFT_PRIORITY.redirect)).toEqual(['a-ads.com', 'track.example']);
    expect(hostsAt(rules, POPUP_PRIORITY.redirect)).toEqual(['ads.example', 'pop.test']);
    const [lifted] = redirects(rules).filter((r) => r.priority === POPUP_LIFT_PRIORITY.redirect);
    expect(lifted?.action).toEqual({ type: 'redirect', redirect: { regexSubstitution: `${BLOCKED}#\\0` } });
    expect(lifted?.condition.resourceTypes).toEqual(['main_frame']);
  });

  test('a host falls back to 2 when its justifying pack is off, and nothing is lifted with the popups pack off', () => {
    expect(hostsAt(desired(settings({ packs: { ads: false } })).dynamicRules, POPUP_LIFT_PRIORITY.redirect)).toEqual(['track.example']);
    expect(hostsAt(desired(settings({ packs: { ads: false } })).dynamicRules, POPUP_PRIORITY.redirect)).toContain('a-ads.com');
    expect(hostsAt(desired(settings({ packs: { popups: false } })).dynamicRules, POPUP_LIFT_PRIORITY.redirect)).toEqual([]);
  });

  test('no redirect of either kind without <all_urls> (S-19)', () => {
    expect(redirects(desired(settings(), GRANTS.onClick).dynamicRules)).toEqual([]);
    expect(redirects(desired(settings(), GRANTS.specificSites).dynamicRules)).toEqual([]);
  });

  test('a lifted host that is not a packaged destination is ignored', () => {
    const inputs = { ...INPUTS, lifted: { ubo: h(['a-ads.com', 'stray.example']) } };
    expect(hostsAt(desired(settings(), GRANTS.allSites, inputs).dynamicRules, POPUP_LIFT_PRIORITY.redirect)).toEqual(['a-ads.com']);
  });

  test('both groups fit the unsafe budget with thousands of hosts, ids inside the realm', () => {
    const many = Array.from({ length: 6_000 }, (_, i) => `d${String(i)}.example`) as Hostname[];
    const inputs = { ...INPUTS, destinations: many, lifted: { ubo: many.slice(0, 1_500) } };
    const rules = redirects(desired(settings(), GRANTS.allSites, inputs).dynamicRules);
    expect(rules.length).toBeLessThanOrEqual(POPUP_REALM_BUDGET.unsafe);
    expect(hostsAt(rules, POPUP_LIFT_PRIORITY.redirect)).toHaveLength(1_500);
    expect(hostsAt(rules, POPUP_PRIORITY.redirect)).toHaveLength(4_500);
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    expect(rules.every((r) => r.id >= DYNAMIC_ID_REALMS.popupDestinations.min + POPUP_REALM_BUDGET.safe && r.id <= DYNAMIC_ID_REALMS.popupDestinations.max)).toBe(true);
  });

  test('the per-site Allow and Off opener allows stay at 3', () => {
    const s = { ...settings(), popups: { mode: 'off' as const, sites: { 'allow.example': 'allow' as const }, notice: true } };
    const allows = desired(s).dynamicRules.filter((r) => dynamicRealmOf(r.id) === 'popupDestinations' && r.action.type === 'allow');
    expect(allows.map((r) => r.priority)).toEqual([POPUP_PRIORITY.allow]);
  });
});

describe('liftedHosts', () => {
  test('is the set computeDesired lifts', () => {
    expect([...liftedHosts(INPUTS, true, ['ubo', 'popups'])]).toEqual(['a-ads.com']);
    expect([...liftedHosts(INPUTS, false, ['ubo', 'popups'])]).toEqual([]);
    expect([...liftedHosts(INPUTS, true, ['ubo'])]).toEqual([]);
    expect([...liftedHosts({ ...INPUTS, blockedPageUrl: null }, true, ['ubo', 'popups'])]).toEqual([]);
  });
});

describe('Proceed once rules across reconciles', () => {
  const lifted = liftedProceedOnceRule('https://a-ads.com/x', 'a-ads.com' as Hostname, 5, []);
  const plain = proceedOnceRule('ads.example' as Hostname, 5, [1]);
  if (lifted === null || plain === null) throw new Error('no rule');

  test('keeps a lifted rule while its host is lifted, and the plain rule always', () => {
    expect(desired(settings(), GRANTS.allSites, INPUTS, [lifted, plain]).sessionRules).toEqual([lifted, plain]);
  });

  test('drops a lifted rule once its host is no longer lifted (pack off, no <all_urls>)', () => {
    expect(desired(settings({ packs: { ads: false } }), GRANTS.allSites, INPUTS, [lifted, plain]).sessionRules).toEqual([plain]);
    expect(desired(settings(), GRANTS.onClick, INPUTS, [lifted, plain]).sessionRules).toEqual([plain]);
  });
});
