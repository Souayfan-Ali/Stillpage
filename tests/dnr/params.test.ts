/**
 * `params-x` suite (P2-30, testing notes §5) and the GPC header (P2-31), in one Chromium launch with every
 * default ruleset plus `params-x` and `gpc-x`. A removeparam rule may match a sign-in or payment
 * redirect (it then rewrites only the keys it lists), but it may never list a key such a redirect
 * carries; every must-allow navigation still passes. GPC: the header rule applies to every type, and the
 * Off rule (`allowAllRequests`, 30,000,000) suppresses it. Needs `npm run lists:build`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { OFF_PRIORITY } from '../../src/core/limits.js';
import { AUTH_REDIRECTS, keysOf } from './data/authRedirects.js';
import { MUST_ALLOW } from './data/mustAllow.js';
import { expectNoSurvivors } from './helpers.js';
import { compiledRulesets } from './support/compiled.js';
import { withExtensions, type TestRuleset } from './support/launch.js';
import { indexRules, outcomes, type DnrCase, type Outcome } from './support/verdict.js';

const LAUNCH_TIMEOUT_MS = 180_000;
const PUBLIC = path.resolve(import.meta.dirname, '../../public');

interface RedirectRule { readonly id: number; readonly action: { readonly redirect?: { readonly transform?: { readonly queryTransform?: { readonly removeParams?: readonly string[] } } } } }
const read = (id: string): readonly RedirectRule[] => JSON.parse(readFileSync(path.join(PUBLIC, 'rulesets', `${id}.json`), 'utf8')) as RedirectRule[];
const params = read('params-x');
const removedBy = new Map(params.map((r) => [r.id, r.action.redirect?.transform?.queryTransform?.removeParams ?? []]));

const OFF: TestRuleset = { id: 'off', rules: [{ id: 1, priority: OFF_PRIORITY, action: { type: 'allowAllRequests' }, condition: { requestDomains: ['off.example'], resourceTypes: ['main_frame'] } }] };
const navigations = MUST_ALLOW.filter((c) => c.type === 'main_frame');
const gpcRows: DnrCase[] = [
  { url: 'https://news.example.org/', type: 'main_frame', expect: 'headers', because: 'GPC on a navigation' },
  { url: 'https://news.example.org/static/js/main.4f2a.js', type: 'script', initiator: 'https://news.example.org', expect: 'headers', because: 'GPC on a subresource' },
  { url: 'https://off.example/', type: 'main_frame', expect: 'allow', because: 'Off suppresses GPC' },
];

let results: { readonly auth: readonly Outcome[]; readonly nav: readonly Outcome[]; readonly gpc: readonly Outcome[] };

beforeAll(async () => {
  const sets: TestRuleset[] = [...compiledRulesets(), ...compiledRulesets(['params-x', 'gpc-x']), OFF];
  results = await withExtensions([{ name: 'params', rulesets: sets, hostAccess: true }], async (w) => {
    const worker = w.get('params');
    if (worker === undefined) throw new Error('extension params did not start');
    const index = indexRules(sets);
    return { auth: await outcomes(worker, AUTH_REDIRECTS, index), nav: await outcomes(worker, navigations, index), gpc: await outcomes(worker, gpcRows, index) };
  });
}, LAUNCH_TIMEOUT_MS);

afterAll(() => {
  expectNoSurvivors();
});

/** Keys of `url` that a matched `params-x` rule would remove. */
function strippedKeys(url: string, outcome: Outcome | undefined): readonly string[] {
  const keys = keysOf(url);
  const ids = (outcome?.rules ?? []).filter((r) => r.startsWith('params-x#')).map((r) => Number(r.slice('params-x#'.length).split(':')[0]));
  return ids.flatMap((id) => (removedBy.get(id) ?? []).filter((k) => keys.includes(k)));
}

describe('params-x and GPC (P2-30, P2-31)', () => {
  test('at least 30 login/payment redirects and 150 must-allow navigations; params-x is compiled', () => {
    expect(AUTH_REDIRECTS.length).toBeGreaterThanOrEqual(30);
    expect(navigations.length).toBeGreaterThanOrEqual(150);
    expect(params.length).toBeGreaterThan(0);
  });

  test('no removeparam rule strips a key a login or payment redirect carries', () => {
    const bad = AUTH_REDIRECTS.flatMap((c, i) => strippedKeys(c.url, results.auth[i]).map((k) => `${c.url}: ${k}`));
    expect(bad).toEqual([]);
    expect(results.auth.every((o) => o.verdict !== 'block' && o.verdict !== 'error')).toBe(true);
  });

  test('no must-allow navigation is blocked, and none loses a key of its URL', () => {
    expect(results.nav.filter((o) => o.verdict === 'block' || o.verdict === 'error')).toEqual([]);
    expect(navigations.flatMap((c, i) => strippedKeys(c.url, results.nav[i]).map((k) => `${c.url}: ${k}`))).toEqual([]);
  });

  test('GPC header on every type; Off suppresses it', () => {
    expect(results.gpc.map((o) => o.verdict)).toEqual(['headers', 'headers', 'allow']);
  });
});
