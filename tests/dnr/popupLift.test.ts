/**
 * D-55 / D-55a lift suite (pop-up notes §6.1–6.2, ADR-011 amendment), in one Chromium launch with the shipped
 * default rulesets and the pop-up realm the reconciler builds:
 * - reproduction: before the lift a-ads.com (a destination easylist/ubo also document-block) ends on the
 *   stock block, not on blocked.html; after it, on the lifted redirect;
 * - the stopped `main_frame` set is identical before and after over the must-allow rows and every lifted
 *   host, with all default rulesets and with each justifying ruleset (and the whole ads pack) off;
 * - a badware document-block host still ends on the stock block; with the ads pack off, the per-site
 *   "Allow pop-ups" opener allow (3) again beats the redirect of a formerly lifted host;
 * - lifted Proceed once: the exact URL passes in its tab only; another URL on the host is redirected, a
 *   badware pattern URL on the host is still stopped;
 * - Off, pause, user rules and site switches still win over the lift band.
 * Needs `npm run lists:build` (public/popup-lifted.json).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { liftedProceedOnceRule } from '../../src/core/blocked/proceed.js';
import type { Hostname } from '../../src/core/ids.js';
import { DYNAMIC_ID_REALMS, OFF_PRIORITY, SWITCH_PRIORITY, USER_PRIORITY_BASE } from '../../src/core/limits.js';
import { siteStateRules } from '../../src/core/reconcile/siteRules.js';
import type { DnrRule } from '../../src/core/reconcile/types.js';
import type { Settings } from '../../src/core/state/types.js';
import { MUST_ALLOW } from './data/mustAllow.js';
import { expectNoSurvivors } from './helpers.js';
import { compiledRulesets } from './support/compiled.js';
import { withExtensions, type TestRuleset } from './support/launch.js';
import { destinations, extensionIdOf, installRules, liftedFile, liftSettings, malwareDocumentHosts, NOW, realmRules, variantSpec, type Variant } from './support/lift.js';
import { indexRules, outcomes, type DnrRequest, type Outcome } from './support/verdict.js';

const LAUNCH_TIMEOUT_MS = 300_000;
const OPENER = 'https://news.example.org';
const ALLOW_OPENER = 'allowpop.example';
const TAB = 5;
const AADS = 'a-ads.com';
const PROCEED_URL = `https://${AADS}/landing?z=1`;
/** A hostless badware `main_frame` pattern (`/click.php?key=*&zoneid=`) on the lifted host. */
const MALWARE_PATTERN_URL = `https://${AADS}/click.php?key=1&zoneid=2`;

const VARIANTS: readonly Variant[] = [
  { name: 'all', off: [] },
  { name: 'easylist-off', off: ['easylist', 'easylist-x'] },
  { name: 'ubo-off', off: ['ubo', 'ubo-x'] },
  { name: 'ads-off', off: ['ubo', 'ubo-x', 'easylist', 'easylist-x'] },
];

const lifted = [...new Set(Object.values(liftedFile()).flat())].sort();
const navigation = (url: string, initiator?: string, tabId?: number): DnrRequest => ({ url, type: 'main_frame', ...(initiator === undefined ? {} : { initiator }), ...(tabId === undefined ? {} : { tabId }) });
const identityRows: readonly DnrRequest[] = [OPENER, `https://${ALLOW_OPENER}`].flatMap((from) => [
  ...MUST_ALLOW.filter((c) => c.type === 'main_frame').map((c) => navigation(c.url, from)),
  ...lifted.flatMap((h) => [navigation(`https://${h}/`, from), navigation(`https://${h}/p?q=1`, from)]),
]);
const stops = (o: Outcome | undefined): boolean => o?.verdict === 'block' || o?.verdict === 'redirect';

/** Lifted hosts that get the overrides (Off, pause, user rule, switch), one each. */
const [OFF_HOST, PAUSED_HOST, USER_HOST, SWITCH_HOST] = lifted.filter((h): h is Hostname => h !== AADS);
const overrideRules = (): readonly DnrRule[] => [
  ...siteStateRules({
    ...liftSettings(ALLOW_OPENER),
    siteLevels: { [OFF_HOST ?? '']: 'off' } as Settings['siteLevels'],
    pauses: { [PAUSED_HOST ?? '']: { until: NOW + 3_600_000 } },
  }, NOW),
  { id: DYNAMIC_ID_REALMS.userRules.min, priority: USER_PRIORITY_BASE, action: { type: 'allow' }, condition: { requestDomains: [USER_HOST ?? ''], resourceTypes: ['main_frame'] } },
  { id: DYNAMIC_ID_REALMS.siteSwitches.min, priority: SWITCH_PRIORITY, action: { type: 'allow' }, condition: { requestDomains: [SWITCH_HOST ?? ''], resourceTypes: ['main_frame'] } },
];

interface Results {
  readonly identity: ReadonlyMap<string, readonly Outcome[]>;
  readonly probes: ReadonlyMap<string, readonly Outcome[]>;
}

let badwareHost = '';
let results: Results;

function probeRows(): readonly DnrRequest[] {
  return [
    navigation(`https://${AADS}/`, OPENER),
    navigation(`https://${badwareHost}/`, OPENER),
    navigation(PROCEED_URL, OPENER, TAB),
    navigation(`https://${AADS}/other`, OPENER, TAB),
    navigation(MALWARE_PATTERN_URL, OPENER, TAB),
    navigation(PROCEED_URL, OPENER, TAB + 1),
    ...[OFF_HOST, PAUSED_HOST, USER_HOST, SWITCH_HOST].map((h) => navigation(`https://${h ?? ''}/`, OPENER)),
    navigation(`https://${AADS}/`, `https://${ALLOW_OPENER}`),
    navigation(`${PROCEED_URL}#top`, OPENER, TAB),
  ];
}
const PROBE = { aads: 0, badware: 1, proceedExact: 2, proceedOther: 3, proceedPattern: 4, proceedOtherTab: 5, off: 6, paused: 7, user: 8, switch: 9, allowOpener: 10, proceedFragment: 11 } as const;

beforeAll(async () => {
  const defaults: readonly TestRuleset[] = compiledRulesets();
  const malware = malwareDocumentHosts(defaults);
  badwareHost = destinations().find((d) => malware.has(d)) ?? '';
  const settings = liftSettings(ALLOW_OPENER);
  const specs = [...VARIANTS.flatMap((v) => [variantSpec(v, defaults, false), variantSpec(v, defaults, true)]), { name: 'overrides', rulesets: defaults, hostAccess: true }];
  results = await withExtensions(specs, async (workers) => {
    const identity = new Map<string, readonly Outcome[]>();
    const probes = new Map<string, readonly Outcome[]>();
    for (const spec of specs) {
      const w = workers.get(spec.name);
      if (w === undefined) throw new Error(`extension ${spec.name} did not start`);
      const variant = VARIANTS.find((v) => spec.name.startsWith(`${v.name}-`)) ?? { name: 'all', off: [] };
      const after = spec.name.endsWith('-after') || spec.name === 'overrides';
      const realm = realmRules(variant, defaults, after, extensionIdOf(w), settings);
      const proceed = liftedProceedOnceRule(PROCEED_URL, AADS as Hostname, TAB, []);
      await installRules(w, [...realm, ...(spec.name === 'overrides' ? overrideRules() : [])], spec.name === 'all-after' && proceed !== null ? [proceed] : []);
      const index = indexRules([...spec.rulesets, { id: '_dynamic', rules: [...realm, ...overrideRules()] }, { id: '_session', rules: proceed === null ? [] : [proceed] }]);
      if (spec.name !== 'overrides') identity.set(spec.name, await outcomes(w, identityRows, index));
      probes.set(spec.name, await outcomes(w, probeRows(), index));
    }
    return { identity, probes };
  });
}, LAUNCH_TIMEOUT_MS);

afterAll(() => {
  expectNoSurvivors();
});

const probe = (ext: string, row: number): Outcome | undefined => results.probes.get(ext)?.[row];

describe('D-55 reproduction: a-ads.com', () => {
  test('is lifted and badware-free in the shipped data', () => {
    expect(lifted).toContain(AADS);
    expect(lifted.length).toBeGreaterThan(400);
    expect(badwareHost).not.toBe('');
  });

  test('before the lift the stock block wins (Chrome error page); after it, the redirect to blocked.html', () => {
    const before = probe('all-before', PROBE.aads);
    expect(before?.verdict).toBe('block');
    expect(['easylist', 'ubo']).toContain(before?.decidedBy?.rulesetId);
    const after = probe('all-after', PROBE.aads);
    expect(after?.verdict).toBe('redirect');
    expect(after?.decidedBy?.rulesetId).toBe('_dynamic');
  });
});

describe('the stopped main_frame set is identical before and after', () => {
  test.each(VARIANTS.map((v) => [v.name] as const))('%s', (name) => {
    const before = results.identity.get(`${name}-before`) ?? [];
    const after = results.identity.get(`${name}-after`) ?? [];
    expect(before).toHaveLength(identityRows.length);
    const differ = identityRows.filter((_, i) => stops(before[i]) !== stops(after[i])).map((r) => `${r.url} from ${r.initiator ?? '-'}`);
    expect(differ).toEqual([]);
    expect(after.some((o) => o.verdict === 'error')).toBe(false);
  });

  test('must-allow navigations still pass with the lift', () => {
    const after = results.identity.get('all-after') ?? [];
    const allowRows = identityRows.map((r, i) => [r, after[i]] as const).filter(([r]) => MUST_ALLOW.some((c) => c.url === r.url));
    expect(allowRows.filter(([, o]) => o !== undefined && stops(o)).map(([r]) => r.url)).toEqual([]);
  });
});

describe('what the lift must not override', () => {
  test('a badware document-block host still ends on the stock block', () => {
    const o = probe('all-after', PROBE.badware);
    expect(o?.verdict).toBe('block');
    expect(o?.decidedBy?.rulesetId).toBe('badware');
  });

  test('ads pack off: the per-site Allow opener allow (3) beats the redirect of a formerly lifted host', () => {
    expect(probe('ads-off-after', PROBE.allowOpener)?.verdict).toBe('allow');
    expect(probe('all-after', PROBE.allowOpener)?.verdict).toBe('redirect');
  });

  test('Off, pause, a user rule and a site switch win over the lift band', () => {
    for (const row of [PROBE.off, PROBE.paused, PROBE.user, PROBE.switch]) {
      const o = probe('overrides', row);
      expect(o?.verdict, `row ${String(row)}`).toBe('allow');
      expect(o?.decidedBy?.rulesetId).toBe('_dynamic');
    }
    expect(OFF_PRIORITY).toBeGreaterThan(SWITCH_PRIORITY);
  });
});

describe('lifted Proceed once: one exact URL in one tab', () => {
  test('the exact URL passes in its tab', () => {
    expect(probe('all-after', PROBE.proceedExact)?.verdict).toBe('allow');
    expect(probe('all-after', PROBE.proceedExact)?.decidedBy?.rulesetId).toBe('_session');
  });

  test('another URL on the host, a badware pattern URL on the host and another tab are still stopped', () => {
    expect(probe('all-after', PROBE.proceedOther)?.verdict).toBe('redirect');
    expect(stops(probe('all-after', PROBE.proceedPattern))).toBe(true);
    expect(probe('all-after', PROBE.proceedOtherTab)?.verdict).toBe('redirect');
    // Chromium matches a navigation with its fragment: the page must navigate to the exact, fragment-less URL.
    expect(probe('all-after', PROBE.proceedFragment)?.verdict).toBe('redirect');
    // The pattern is a malware block before the lift, so the bypass never reaches it.
    expect(probe('all-before', PROBE.proceedPattern)?.decidedBy?.rulesetId).toBe('badware');
  });
});
