/**
 * D-55 / D-55a: the lifted subset of pop-up destinations. Lifted = a destination that a default non-malware
 * ruleset (easylist, ubo, easyprivacy) document-blocks unconditionally, minus hosts equal to / parent of /
 * subdomain of a badware or urlhaus unconditional document-block host, minus hosts any stock main_frame
 * allow could touch. `liftViolations` re-checks a given file against given rulesets (verify and daily drift).
 */
import { describe, expect, test } from 'vitest';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { LIFT_DRIFT_DEADLINE_HOURS, liftDriftReport, liftedDestinations, liftViolations } from '../../../../compiler/popups/lift.js';

let next = 1;
const rule = (action: DnrRule['action']['type'], condition: DnrRule['condition']): DnrRule =>
  ({ id: (next += 1), priority: 10, action: { type: action }, condition });
const docBlock = (hosts: readonly string[]): DnrRule => rule('block', { requestDomains: [...hosts], resourceTypes: ['main_frame'] });
const docBlockFilter = (host: string): DnrRule => rule('block', { urlFilter: `||${host}^`, resourceTypes: ['main_frame'] });

const DEST = ['a-ads.com', 'adsco.re', 'evil-pop.net', 'goodads.org', 'pathonly.io', 'tracker.example', 'sub.parent-mal.com', 'parentof.org'];
const rulesets = (extra: Readonly<Record<string, readonly DnrRule[]>> = {}): ReadonlyMap<string, readonly DnrRule[]> => new Map(Object.entries({
  easylist: [docBlock(['a-ads.com', 'evil-pop.net', 'goodads.org', 'sub.parent-mal.com', 'parentof.org']), rule('block', { urlFilter: '||pathonly.io/ad^', resourceTypes: ['main_frame'] })],
  ubo: [docBlockFilter('adsco.re'), rule('block', { requestDomains: ['tracker.example'], resourceTypes: ['main_frame'], domainType: 'thirdParty' })],
  easyprivacy: [],
  badware: [docBlock(['evil-pop.net', 'parent-mal.com']), docBlock(['x.parentof.org']),
    rule('block', { requestDomains: ['com'], regexFilter: '^https://amazo', resourceTypes: ['main_frame'] }),
    rule('block', { urlFilter: '/click.php?key=', resourceTypes: ['main_frame'] })],
  urlhaus: [],
  'annoy-overlays': [rule('allowAllRequests', { urlFilter: '||goodads.org/optout', resourceTypes: ['main_frame'] })],
  ...extra,
}));

describe('liftedDestinations', () => {
  test('lifts unconditional non-malware document blocks, keyed by justifying ruleset, minus the exclusions', () => {
    const out = liftedDestinations(DEST, rulesets());
    expect(out.lifted).toEqual({ easylist: ['a-ads.com'], ubo: ['adsco.re'] });
    expect(out.summary).toEqual({
      candidates: 6,
      lifted: 2,
      byRuleset: { easylist: 1, ubo: 1 },
      excluded: { malware: ['evil-pop.net', 'parentof.org', 'sub.parent-mal.com'], allow: ['goodads.org'] },
    });
  });

  test('a path, a domainType or a TLD-scoped pattern is not a document block of the host', () => {
    const { lifted } = liftedDestinations(DEST, rulesets());
    const all = Object.values(lifted).flat();
    expect(all).not.toContain('pathonly.io');
    expect(all).not.toContain('tracker.example');
  });

  test('an allow on a parent, a subdomain or a TLD of the host excludes it, whatever its path (D-55a item 6)', () => {
    const allowOn = (host: string) => rulesets({ 'reg-de': [rule('allow', { requestDomains: [host], urlFilter: '/x', resourceTypes: ['main_frame'] })] });
    expect(liftedDestinations(DEST, allowOn('com')).lifted).toEqual({ ubo: ['adsco.re'] });
    expect(liftedDestinations(DEST, allowOn('www.a-ads.com')).lifted).toEqual({ ubo: ['adsco.re'] });
    expect(liftedDestinations(DEST, allowOn('re')).lifted).toEqual({ easylist: ['a-ads.com'] });
  });

  test('an allow that is not on main_frame does not exclude', () => {
    const extra = rulesets({ 'reg-de': [rule('allow', { requestDomains: ['a-ads.com'], resourceTypes: ['script'] })] });
    expect(liftedDestinations(DEST, extra).lifted).toEqual({ easylist: ['a-ads.com'], ubo: ['adsco.re'] });
  });

  test('a malware `||prefix` filter without ^ excludes every host it can block by prefix (security review MEDIUM)', () => {
    const prefix = (p: string) => rulesets({ urlhaus: [rule('block', { urlFilter: `||${p}`, resourceTypes: ['main_frame'] })] });
    expect(liftedDestinations(DEST, prefix('a-ads.')).lifted).toEqual({ ubo: ['adsco.re'] });
    expect(liftedDestinations(DEST, prefix('adsc')).lifted).toEqual({ easylist: ['a-ads.com'] });
    expect(liftedDestinations(DEST, prefix('a-ads.com')).lifted).toEqual({ ubo: ['adsco.re'] });
    // A prefix that names no label of the host leaves it lifted.
    expect(liftedDestinations(DEST, prefix('promo-code-')).lifted).toEqual({ easylist: ['a-ads.com'], ubo: ['adsco.re'] });
    expect(liftViolations({ easylist: ['a-ads.com'] }, prefix('a-ad')).malware).toEqual(['a-ads.com']);
  });

  test('a hostless stock main_frame allow fails the build and is listed', () => {
    const extra = rulesets({ 'reg-ja': [rule('allowAllRequests', { urlFilter: '/checkout', resourceTypes: ['main_frame'] })] });
    expect(() => liftedDestinations(DEST, extra)).toThrow(/hostless main_frame allow.*reg-ja#\d+/);
  });

  test('the popups ruleset itself never justifies or excludes', () => {
    const extra = rulesets({ popups: [docBlock(['pathonly.io']), rule('allow', { requestDomains: ['a-ads.com'], resourceTypes: ['main_frame'] })] });
    expect(liftedDestinations(DEST, extra).lifted).toEqual({ easylist: ['a-ads.com'], ubo: ['adsco.re'] });
  });
});

describe('liftViolations (verify and daily drift, D-55a item 8)', () => {
  test('none for the file the build made', () => {
    const r = rulesets();
    expect(liftViolations(liftedDestinations(DEST, r).lifted, r)).toEqual({ malware: [], allow: [], unjustified: [], hostlessAllows: [] });
  });

  test('classifies drift: a newly malware-listed host, a new allow, a dropped justification', () => {
    const shipped = { easylist: ['a-ads.com'], ubo: ['adsco.re', 'gone.example'] };
    const r = rulesets({
      urlhaus: [docBlockFilter('cdn.a-ads.com')],
      'reg-nl': [rule('allow', { urlFilter: '||adsco.re/ok', resourceTypes: ['main_frame'] }), rule('allowAllRequests', { regexFilter: '^https://x/', resourceTypes: ['main_frame'] })],
    });
    const v = liftViolations(shipped, r);
    expect(v.malware).toEqual(['a-ads.com']);
    expect(v.allow).toEqual(['adsco.re']);
    expect(v.unjustified).toEqual(['gone.example']);
    expect(v.hostlessAllows).toHaveLength(1);
  });

  test('a host keyed under a ruleset that does not justify lifting is unjustified', () => {
    expect(liftViolations({ badware: ['a-ads.com'] }, rulesets()).unjustified).toEqual(['a-ads.com']);
  });
});

describe('liftDriftReport (daily ruleset-only job, D-55a items 8c–8d)', () => {
  test('no drift: no deadline', () => {
    const r = rulesets();
    expect(liftDriftReport(liftedDestinations(DEST, r).lifted, r)).toMatchObject({ schema: 1, drift: false, fullReleaseWithinHours: null });
  });

  test('malware drift requires a full release within 48 h, any other within 7 days', () => {
    expect(liftDriftReport({ easylist: ['a-ads.com'] }, rulesets({ urlhaus: [docBlock(['a-ads.com'])] })).fullReleaseWithinHours).toBe(LIFT_DRIFT_DEADLINE_HOURS.malware);
    expect(liftDriftReport({ ubo: ['gone.example'] }, rulesets())).toMatchObject({ drift: true, fullReleaseWithinHours: 168 });
  });
});
