/**
 * DNR behaviour suites (P1-44, testing notes §5): semantics, must-block and must-allow — every row through
 * `testMatchOutcome` in **one** Chromium launch holding five unpacked extensions:
 * - `compiled`: the default packs' rulesets exactly as `npm run lists:build` emitted them into
 *   `public/rulesets/`, every one on (`-x` included: the all-sites configuration);
 * - `sem-all` / `sem-none`: the hand-written feature ruleset with all-sites access and with none;
 * - `conv`: one filter per conversion rule, compiled by the real compiler post-pass;
 * - `fixtures`: the fixture corpus's filters compiled the same way (P1-42's hand conversions replaced),
 *   checked against the fixtures' own network expectations;
 * plus the two regex pools (static over enabled rulesets; dynamic + session shared), measured on a
 * sixth extension. Needs `npm run lists:build` to have run (it reads `public/`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadFixtures, type FixtureEntry, type Observation } from '../fixtures/manifest.js';
import { compileFilters } from '../helpers/compileFilters.js';
import { MUST_ALLOW } from './data/mustAllow.js';
import { MUST_BLOCK } from './data/mustBlock.js';
import { CONVERSIONS, FEATURE_ROWS, SEMANTIC_RULES } from './data/semantics.js';
import { expectNoSurvivors } from './helpers.js';
import { compiledRulesets } from './support/compiled.js';
import { withExtensions, type ExtensionSpec, type TestRuleset } from './support/launch.js';
import { measurePools, poolRulesets, type PoolResults } from './support/pools.js';
import { failures, indexRules, outcomes, type DnrCase, type Outcome } from './support/verdict.js';

/** P1-44: at least this many table rows, green, in one launch. */
const MIN_ROWS = 1_300;
const LAUNCH_TIMEOUT_MS = 240_000;
/** Fixture rows need a tab (`topDomains`) or are not DNR effects (CSP): left to the E2E corpus. */
const FIXTURES_OUTSIDE_DNR = new Set(['net/top-domains', 'net/top-domains-other', 'redirect/csp']);
const TABLE_FAMILIES = new Set(['net', 'redirect', 'permissions', 'anti-adblock']);

const typeOf = (url: string): string => {
  const ext = new URL(url).pathname.split('.').pop() ?? '';
  if (ext === 'js') return 'script';
  if (['gif', 'png', 'jpg'].includes(ext)) return 'image';
  return ext === 'html' ? 'sub_frame' : 'other';
};

function fixtureRows(fixtures: readonly FixtureEntry[]): DnrCase[] {
  const usable = fixtures.filter((f) => TABLE_FAMILIES.has(f.family) && f.pending === undefined && !FIXTURES_OUTSIDE_DNR.has(f.id));
  return usable.flatMap((f) => {
    const navigations = new Set(f.expect.flatMap((o: Observation) => ('navigation' in o ? [o.navigation] : [])));
    return f.expect.flatMap((o): DnrCase[] => {
      const because = `fixture ${f.id}`;
      const expect = o.is === 'blocked' ? 'stop' : 'pass';
      if ('navigation' in o) return [{ url: o.navigation, type: 'main_frame', expect, because }];
      if (!('request' in o) || navigations.has(o.request)) return [];
      return [{ url: o.request, type: typeOf(o.request), initiator: new URL(f.page).origin, expect, because }];
    });
  });
}

interface Results {
  readonly mustBlock: readonly Outcome[];
  readonly mustAllow: readonly Outcome[];
  readonly featureAll: readonly Outcome[];
  readonly featureNone: readonly Outcome[];
  readonly conversions: readonly Outcome[];
  readonly fixtures: readonly Outcome[];
  readonly pools: PoolResults;
}

const featureAll = FEATURE_ROWS.filter((c) => c.access === 'all');
const featureNone = FEATURE_ROWS.filter((c) => c.access === 'none');
const conversionRows = CONVERSIONS.flatMap((c) => c.rows);
const fixtureCases = fixtureRows(loadFixtures());
let results: Results;

interface Sets {
  readonly compiled: readonly TestRuleset[];
  readonly sem: readonly TestRuleset[];
  readonly conv: readonly TestRuleset[];
  readonly fixtures: readonly TestRuleset[];
  readonly pools: readonly TestRuleset[];
}

async function specs(): Promise<{ list: readonly ExtensionSpec[]; rulesets: Sets }> {
  const sem: TestRuleset[] = [{ id: 'sem', rules: SEMANTIC_RULES }];
  const conv = await compileFilters(CONVERSIONS.flatMap((c) => c.filters));
  const fx = await compileFilters([...new Set(loadFixtures().flatMap((f) => f.filters))].sort());
  const rulesets: Sets = {
    compiled: compiledRulesets(),
    sem,
    conv: [{ id: 'conv', rules: conv.safe }, { id: 'conv-x', rules: conv.unsafe }],
    fixtures: [{ id: 'fx', rules: fx.safe }, { id: 'fx-x', rules: fx.unsafe }],
    pools: poolRulesets(),
  };
  const list: ExtensionSpec[] = [
    { name: 'compiled', rulesets: rulesets.compiled, hostAccess: true },
    { name: 'sem-all', rulesets: sem, hostAccess: true },
    { name: 'sem-none', rulesets: sem, hostAccess: false },
    { name: 'conv', rulesets: rulesets.conv, hostAccess: true },
    { name: 'fixtures', rulesets: rulesets.fixtures, hostAccess: true },
    { name: 'pools', rulesets: rulesets.pools, hostAccess: false },
  ];
  return { list, rulesets };
}

beforeAll(async () => {
  const { list, rulesets } = await specs();
  results = await withExtensions(list, async (w) => {
    const run = (name: string, cases: readonly DnrCase[], sets: readonly TestRuleset[]): Promise<readonly Outcome[]> => {
      const worker = w.get(name);
      if (worker === undefined) throw new Error(`extension ${name} did not start`);
      return outcomes(worker, cases, indexRules(sets));
    };
    const pools = w.get('pools');
    if (pools === undefined) throw new Error('extension pools did not start');
    return {
      mustBlock: await run('compiled', MUST_BLOCK, rulesets.compiled),
      mustAllow: await run('compiled', MUST_ALLOW, rulesets.compiled),
      featureAll: await run('sem-all', featureAll, rulesets.sem),
      featureNone: await run('sem-none', featureNone, rulesets.sem),
      conversions: await run('conv', conversionRows, rulesets.conv),
      fixtures: await run('fixtures', fixtureCases, rulesets.fixtures),
      pools: await measurePools(pools),
    };
  });
}, LAUNCH_TIMEOUT_MS);

afterAll(() => {
  expectNoSurvivors();
});

describe('DNR suites in one launch (P1-44)', () => {
  test(`at least ${String(MIN_ROWS)} table rows`, () => {
    const rows = MUST_BLOCK.length + MUST_ALLOW.length + FEATURE_ROWS.length + conversionRows.length + fixtureCases.length;
    expect(rows).toBeGreaterThanOrEqual(MIN_ROWS);
    expect(MUST_BLOCK.length).toBeGreaterThanOrEqual(500);
    expect(MUST_ALLOW.filter((c) => c.type === 'main_frame').length).toBeGreaterThanOrEqual(150);
  });

  test('semantics: DNR features with all-sites access', () => {
    expect(failures(featureAll, results.featureAll)).toEqual([]);
  });

  test('semantics: without host access a redirect shadows a lower block; modifyHeaders does not', () => {
    expect(failures(featureNone, results.featureNone)).toEqual([]);
  });

  test('semantics: conversion rules through the real compiler', () => {
    expect(failures(conversionRows, results.conversions)).toEqual([]);
  });

  test('semantics: the fixture corpus compiled from its filters meets the fixtures’ network expectations', () => {
    expect(fixtureCases.length).toBeGreaterThanOrEqual(15);
    expect(failures(fixtureCases, results.fixtures)).toEqual([]);
  });

  test('semantics: the static regex pool counts enabled rulesets; dynamic and session share another pool', () => {
    expect(results.pools).toEqual({
      staticOverLimit: 'rejected',
      staticAtLimit: 'enabled',
      dynamicAndSessionBesideFullStatic: 'accepted',
      sharedPoolOverLimit: 'rejected',
    });
  });

  test('must-block: well-known ad and tracker endpoints are stopped by the compiled default rulesets', () => {
    expect(failures(MUST_BLOCK, results.mustBlock)).toEqual([]);
  });

  test('must-allow: top sites, sign-in, payment, captcha, CDNs and their navigations pass', () => {
    expect(failures(MUST_ALLOW, results.mustAllow)).toEqual([]);
  });
});
