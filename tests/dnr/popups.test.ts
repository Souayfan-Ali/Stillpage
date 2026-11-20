/**
 * `popups` ruleset suite (P1-50, testing notes §5, pop-up notes §6): the compiled `popups` ruleset loaded alone
 * and with every default ruleset, in one Chromium launch. ~100 pop-up destinations (sampled evenly
 * from `popup-destinations.json`) must be blocked as `main_frame` navigations *by a `popups` rule*,
 * and every must-allow `main_frame` row (top sites, sign-in, payment, SSO) must pass. MVP behaviour is
 * block-only: no redirect to `blocked.html` yet (pop-up notes §6.1). Needs `npm run lists:build`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MUST_ALLOW } from './data/mustAllow.js';
import { expectNoSurvivors } from './helpers.js';
import { compiledRulesets } from './support/compiled.js';
import { withExtensions, type TestRuleset } from './support/launch.js';
import { failures, indexRules, outcomes, type DnrCase, type Outcome } from './support/verdict.js';

const DESTINATION_ROWS = 100;
const LAUNCH_TIMEOUT_MS = 180_000;
const OPENER = 'https://news.example.org';
const PUBLIC = path.resolve(import.meta.dirname, '../../public');

/** Every `step`-th destination, so the sample covers the whole sorted list deterministically. */
function sampleDestinations(): readonly string[] {
  const all = JSON.parse(readFileSync(path.join(PUBLIC, 'popup-destinations.json'), 'utf8')) as string[];
  const step = Math.max(1, Math.floor(all.length / DESTINATION_ROWS));
  return all.filter((_, i) => i % step === 0).slice(0, DESTINATION_ROWS);
}

const destinations = sampleDestinations();
const destinationRows: DnrCase[] = destinations.map((h) => ({ url: `https://${h}/`, type: 'main_frame', initiator: OPENER, expect: 'block', because: `pop-up destination ${h}` }));
const allowRows = MUST_ALLOW.filter((c) => c.type === 'main_frame');

let results: { readonly popupsOnly: readonly Outcome[]; readonly allowPopupsOnly: readonly Outcome[]; readonly allowDefaults: readonly Outcome[] };

beforeAll(async () => {
  const defaults = compiledRulesets();
  const popups: TestRuleset[] = defaults.filter((r) => r.id === 'popups');
  results = await withExtensions([
    { name: 'popups', rulesets: popups, hostAccess: false },
    { name: 'defaults', rulesets: defaults, hostAccess: true },
  ], async (w) => {
    const run = (name: string, cases: readonly DnrCase[], sets: readonly TestRuleset[]) => {
      const worker = w.get(name);
      if (worker === undefined) throw new Error(`extension ${name} did not start`);
      return outcomes(worker, cases, indexRules(sets));
    };
    return {
      popupsOnly: await run('popups', destinationRows, popups),
      allowPopupsOnly: await run('popups', allowRows, popups),
      allowDefaults: await run('defaults', allowRows, defaults),
    };
  });
}, LAUNCH_TIMEOUT_MS);

afterAll(() => {
  expectNoSurvivors();
});

describe('popups ruleset (P1-50)', () => {
  test(`${String(DESTINATION_ROWS)} destinations sampled and at least 150 must-allow main_frame rows`, () => {
    expect(destinationRows).toHaveLength(DESTINATION_ROWS);
    expect(allowRows.length).toBeGreaterThanOrEqual(150);
  });

  test('pop-up destinations are blocked as main_frame navigations by a popups rule, without host access', () => {
    expect(failures(destinationRows, results.popupsOnly)).toEqual([]);
    expect(results.popupsOnly.every((o) => o.decidedBy?.rulesetId === 'popups')).toBe(true);
  });

  test('must-allow navigations pass the popups ruleset alone and with every default ruleset', () => {
    expect(failures(allowRows, results.allowPopupsOnly)).toEqual([]);
    expect(failures(allowRows, results.allowDefaults)).toEqual([]);
  });
});
