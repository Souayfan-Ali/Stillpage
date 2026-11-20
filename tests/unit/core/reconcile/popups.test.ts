/**
 * P2-54 (pop-up notes §6.2, §7.6, architecture notes §9–10): the pop-up guard registrations and the pop-up dynamic
 * realm for every mode × default level × grant row. Guard registrations are top-level documents only;
 * redirect rules exist only with `<all_urls>`; `allow` rules in every row; realm budget 20 / 20 / 20.
 */
import { describe, expect, test } from 'vitest';
import type { Hostname } from '../../../../src/core/ids.js';
import { DYNAMIC_ID_REALMS, MAX_SITES_PER_LEVEL, POPUP_PRIORITY, dynamicRealmOf } from '../../../../src/core/limits.js';
import { computeDesired, DEFAULT_DESIRED_LIMITS } from '../../../../src/core/reconcile/computeDesired.js';
import { POPUP_REALM_BUDGET, POPUP_SCRIPTS, type PopupInputs } from '../../../../src/core/reconcile/popups.js';
import type { DnrRule, Grants, ScriptRegistration } from '../../../../src/core/reconcile/types.js';
import type { DefaultLevel, PopupMode, Settings } from '../../../../src/core/state/types.js';
import { GRANTS, NOW, settings, testCatalog } from './fixtures.js';

const BLOCKED = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/blocked.html';
const sites = (record: Record<string, 'allow' | 'strict'>): Settings['popups']['sites'] => record;
const h = (hosts: readonly string[]): readonly Hostname[] => hosts as readonly Hostname[];
const INPUTS: PopupInputs = {
  destinations: h(['ads.example', 'pop.test']),
  lifted: {},
  strictSites: h(['list.example']),
  blockedPageUrl: BLOCKED,
  guardShipped: true,
  listStrict: true,
};

function rowSettings(mode: PopupMode, defaultLevel: DefaultLevel): Settings {
  const base = settings({
    defaultLevel,
    siteLevels: { 'off.example': 'off', 'light.example': 'light', 'up.example': 'thorough' },
    pauses: { 'paused.example': NOW + 60_000 },
  });
  return { ...base, popups: { mode, sites: sites({ 'allow.example': 'allow', 'strict.example': 'strict' }), notice: true } };
}

const desired = (s: Settings, grants: Grants, inputs: PopupInputs = INPUTS) =>
  computeDesired(s, grants, testCatalog(), NOW, DEFAULT_DESIRED_LIMITS, { popups: inputs });
const popupScripts = (scripts: readonly ScriptRegistration[]) => scripts.filter((r) => r.id.startsWith('popup-'));
const realm = (rules: readonly DnrRule[]) => rules.filter((r) => dynamicRealmOf(r.id) === 'popupDestinations');

const EXCLUDED = ['*://*.allow.example/*', '*://*.light.example/*', '*://*.off.example/*', '*://*.paused.example/*'];
const STRICT_HOSTS = ['*://*.list.example/*', '*://*.strict.example/*'];
const UP = ['*://*.up.example/*'];

/** Expected `matches` of [sentinel + shim, popup-strict] per mode and default level (`null`: not registered). */
function expectedMatches(mode: PopupMode, level: DefaultLevel): readonly [readonly string[] | null, readonly string[] | null] {
  const everywhere = level === 'light' ? UP : ['<all_urls>'];
  const strictHosts = level === 'light' ? null : STRICT_HOSTS;
  if (mode === 'off') return [strictHosts, strictHosts];
  return mode === 'smart' ? [everywhere, strictHosts] : [everywhere, everywhere];
}

const MODES: readonly PopupMode[] = ['off', 'smart', 'strict'];
const LEVELS: readonly DefaultLevel[] = ['light', 'standard', 'thorough'];
const GRANT_ROWS = Object.entries(GRANTS) as [keyof typeof GRANTS, Grants][];
const ROWS = MODES.flatMap((mode) => LEVELS.flatMap((level) => GRANT_ROWS.map(([grant, grants]) => [mode, level, grant, grants] as const)));

describe('pop-up registrations and realm: every mode × level × grant row', () => {
  test.each(ROWS)('mode %s, default %s, %s', (mode, level, grant, grants) => {
    const state = desired(rowSettings(mode, level), grants);
    const scripts = popupScripts(state.contentScripts);
    const [guard, strict] = expectedMatches(mode, level);
    const byId = (id: string) => scripts.find((r) => r.id === id);

    // Registrations never depend on grants (S-10); all three are top-level documents only (ADR-016 as amended).
    expect(byId('popup-sentinel')?.matches ?? null).toEqual(guard);
    expect(byId('popup-shim')?.matches ?? null).toEqual(guard);
    expect(byId('popup-strict')?.matches ?? null).toEqual(strict);
    expect(scripts.every((r) => !r.allFrames && r.persistAcrossSessions)).toBe(true);
    if (guard !== null) expect([byId('popup-sentinel')?.js, byId('popup-shim')?.js]).toEqual([[POPUP_SCRIPTS.sentinel], [POPUP_SCRIPTS.shim]]);
    expect(byId('popup-sentinel')?.world ?? 'ISOLATED').toBe('ISOLATED');
    expect(byId('popup-shim')?.world ?? 'MAIN').toBe('MAIN');
    if (guard?.[0] === '<all_urls>') expect(byId('popup-sentinel')?.excludeMatches).toEqual(EXCLUDED);

    // `allow` in every row (Allow sites ∪ Off and paused roots, as opener); redirect only with `<all_urls>` (S-19).
    const rules = realm(state.dynamicRules);
    const allow = rules.filter((r) => r.action.type === 'allow');
    const redirect = rules.filter((r) => r.action.type === 'redirect');
    expect(allow.flatMap((r) => r.condition.initiatorDomains ?? [])).toEqual(['allow.example', 'off.example', 'paused.example']);
    expect(allow.every((r) => r.priority === POPUP_PRIORITY.allow && r.condition.resourceTypes?.join() === 'main_frame')).toBe(true);
    expect(redirect.length > 0).toBe(grant === 'allSites');
    expect(redirect.flatMap((r) => r.condition.requestDomains ?? [])).toEqual(grant === 'allSites' ? ['ads.example', 'pop.test'] : []);
  });
});

describe('pop-up redirect rules', () => {
  test('carry the URL to blocked.html in the fragment, below every stock rule', () => {
    const [rule] = realm(desired(rowSettings('off', 'standard'), GRANTS.allSites).dynamicRules).filter((r) => r.action.type === 'redirect');
    expect(rule).toEqual({
      id: DYNAMIC_ID_REALMS.popupDestinations.min + POPUP_REALM_BUDGET.safe,
      priority: POPUP_PRIORITY.redirect,
      action: { type: 'redirect', redirect: { regexSubstitution: `${BLOCKED}#\\0` } },
      condition: { regexFilter: '^https?://.*', requestDomains: ['ads.example', 'pop.test'], resourceTypes: ['main_frame'] },
    });
  });

  test('none until the blocked page ships; no guard until its scripts ship; no list strict sites when the owner turns them off', () => {
    const state = desired(rowSettings('off', 'standard'), GRANTS.allSites, { ...INPUTS, blockedPageUrl: null, guardShipped: false });
    expect(realm(state.dynamicRules).some((r) => r.action.type === 'redirect')).toBe(false);
    expect(popupScripts(state.contentScripts)).toEqual([]);
    const noList = desired(rowSettings('off', 'standard'), GRANTS.allSites, { ...INPUTS, listStrict: false });
    expect(popupScripts(noList.contentScripts).map((r) => r.matches)).toEqual([['*://*.strict.example/*'], ['*://*.strict.example/*'], ['*://*.strict.example/*']]);
  });

  test('without pop-up inputs nothing of the realm or the guard is produced', () => {
    const state = computeDesired(rowSettings('smart', 'standard'), GRANTS.allSites, testCatalog(), NOW);
    expect(realm(state.dynamicRules)).toEqual([]);
    expect(popupScripts(state.contentScripts)).toEqual([]);
  });

  test('P2-59: the notice turned off adds the popup-quiet flag exactly where the sentinel runs, in every mode', () => {
    for (const mode of MODES) {
      const on = popupScripts(desired(rowSettings(mode, 'standard'), GRANTS.allSites).contentScripts);
      expect(on.some((r) => r.id === 'popup-quiet')).toBe(false);
      const quietSettings = rowSettings(mode, 'standard');
      const off = popupScripts(desired({ ...quietSettings, popups: { ...quietSettings.popups, notice: false } }, GRANTS.onClick).contentScripts);
      const byId = (id: string) => off.find((r) => r.id === id);
      expect(byId('popup-quiet')).toMatchObject({ js: [POPUP_SCRIPTS.quiet], world: 'ISOLATED', allFrames: false, runAt: 'document_start' });
      expect(byId('popup-quiet')?.matches).toEqual(byId('popup-sentinel')?.matches);
      expect(byId('popup-quiet')?.excludeMatches).toEqual(byId('popup-sentinel')?.excludeMatches);
    }
  });

  test('mode off with no strict site at all registers nothing, and no allow rule without Allow or Off sites', () => {
    const state = desired(settings(), GRANTS.onClick, { ...INPUTS, strictSites: [] });
    expect(popupScripts(state.contentScripts)).toEqual([]);
    expect(realm(state.dynamicRules)).toEqual([]);
  });
});

describe('pop-up realm budget 20 / 20 / 20 (architecture notes §10)', () => {
  test('the largest valid settings and the full destination list stay inside the realm', () => {
    const many = (prefix: string): string[] => Array.from({ length: MAX_SITES_PER_LEVEL }, (_, i) => `${prefix}${String(i)}.com`);
    const base = settings({
      siteLevels: Object.fromEntries(many('o').map((host) => [host, 'off' as const])),
      pauses: Object.fromEntries(many('p').map((host) => [host, NOW + 1])),
    });
    const s: Settings = { ...base, popups: { mode: 'smart', sites: sites(Object.fromEntries(many('a').map((host) => [host, 'allow' as const]))), notice: true } };
    const destinations = h(Array.from({ length: 6_000 }, (_, i) => `d${String(i)}.test`));
    const rules = realm(desired(s, GRANTS.allSites, { ...INPUTS, destinations }).dynamicRules);
    const allow = rules.filter((r) => r.action.type === 'allow');
    const redirect = rules.filter((r) => r.action.type === 'redirect');

    expect(allow.flatMap((r) => r.condition.initiatorDomains ?? [])).toHaveLength(3 * MAX_SITES_PER_LEVEL);
    expect(redirect.flatMap((r) => r.condition.requestDomains ?? [])).toHaveLength(6_000);
    expect(allow.length).toBeLessThanOrEqual(POPUP_REALM_BUDGET.safe);
    expect(redirect.length).toBeLessThanOrEqual(POPUP_REALM_BUDGET.unsafe);
    expect(rules.filter((r) => r.condition.regexFilter !== undefined).length).toBeLessThanOrEqual(POPUP_REALM_BUDGET.regex);
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
  });

  test('the allow rule lists only roots: a subdomain of an Allow site is not repeated', () => {
    const s: Settings = { ...settings(), popups: { mode: 'off', sites: sites({ 'a.com': 'allow', 'x.a.com': 'allow' }), notice: true } };
    const allow = realm(desired(s, GRANTS.onClick).dynamicRules).filter((r) => r.action.type === 'allow');
    expect(allow.flatMap((r) => r.condition.initiatorDomains ?? [])).toEqual(['a.com']);
  });
});

describe('fixed registrations count in the budgets (P2-32)', () => {
  test('the guard and GPC registrations take their patterns and slots before the packs', () => {
    const s: Settings = { ...rowSettings('off', 'standard'), gpc: false };
    const free = desired(s, GRANTS.allSites);
    const guardPatterns = popupScripts(free.contentScripts).reduce((n, r) => n + r.matches.length, 0);
    const packPatterns = free.contentScripts.filter((r) => !r.id.startsWith('popup-')).reduce((n, r) => n + r.matches.length, 0);
    const tight = computeDesired(s, GRANTS.allSites, testCatalog(), NOW, { ...DEFAULT_DESIRED_LIMITS, patterns: guardPatterns + packPatterns - 1 }, { popups: INPUTS });
    expect(tight.skippedPacks.map((p) => p.reason)).toContain('patterns');
    const slots = computeDesired(s, GRANTS.allSites, testCatalog(), NOW, { ...DEFAULT_DESIRED_LIMITS, registrations: free.contentScripts.length - 1 }, { popups: INPUTS });
    expect(slots.skippedPacks.map((p) => p.reason)).toContain('registrations');
  });
});
