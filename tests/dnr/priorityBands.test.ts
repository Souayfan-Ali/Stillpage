/**
 * Priority bands in the bundled Chromium (re-band ruling D-55b after the 24-bit finding; ADR-011
 * amendment). Chromium matches on 24 bits of priority: the CANARY pins that (16,777,216 + x behaves like
 * x). If the canary fails, Chromium changed: update ADR-011 and docs/limits.md — every band is below
 * 2^24, so the product's order holds either way. The precedence rows check the real band constants.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CHROME_EFFECTIVE_PRIORITY_MAX, OFF_PRIORITY, POPUP_LIFT_PRIORITY, STOCK_PRIORITY_MAX, SWITCH_PRIORITY, USER_PRIORITY_BASE, USER_RULE_PRIORITY_MAX } from '../../src/core/limits.js';
import { expectNoSurvivors } from './helpers.js';
import { withExtensions } from './support/launch.js';

const LAUNCH_TIMEOUT_MS = 120_000;
const WRAP = CHROME_EFFECTIVE_PRIORITY_MAX + 1;
const LIFT = POPUP_LIFT_PRIORITY.redirect;

interface Pair { readonly name: string; readonly high: { readonly priority: number; readonly type: string }; readonly low: { readonly priority: number; readonly type: string }; readonly winner: 'high' | 'low' }

/** Each pair: two rules on one host; the row says which must decide. */
const PAIRS: readonly Pair[] = [
  { name: 'canary: 16,777,215 beats the lift redirect', high: { priority: CHROME_EFFECTIVE_PRIORITY_MAX, type: 'allow' }, low: { priority: LIFT, type: 'redirect' }, winner: 'high' },
  { name: 'canary: 2^24 + 4,999,999 loses to 5,000,000 (wraps)', high: { priority: WRAP + LIFT - 1, type: 'allow' }, low: { priority: LIFT, type: 'redirect' }, winner: 'low' },
  { name: 'canary: 2^24 + 5,000,001 beats 5,000,000 (wraps)', high: { priority: WRAP + LIFT + 1, type: 'allow' }, low: { priority: LIFT, type: 'redirect' }, winner: 'high' },
  { name: 'Off beats the lift redirect', high: { priority: OFF_PRIORITY, type: 'allowAllRequests' }, low: { priority: LIFT, type: 'redirect' }, winner: 'high' },
  { name: 'Off beats a lift Proceed once', high: { priority: OFF_PRIORITY, type: 'allowAllRequests' }, low: { priority: POPUP_LIFT_PRIORITY.allow, type: 'allow' }, winner: 'high' },
  { name: 'Off beats a block at the user top', high: { priority: OFF_PRIORITY, type: 'allowAllRequests' }, low: { priority: USER_PRIORITY_BASE + USER_RULE_PRIORITY_MAX, type: 'block' }, winner: 'high' },
  { name: 'a switch beats a block at the user top', high: { priority: SWITCH_PRIORITY, type: 'allow' }, low: { priority: USER_PRIORITY_BASE + USER_RULE_PRIORITY_MAX, type: 'block' }, winner: 'high' },
  { name: 'a switch beats the lift redirect', high: { priority: SWITCH_PRIORITY, type: 'allow' }, low: { priority: LIFT, type: 'redirect' }, winner: 'high' },
  { name: 'a block at the user base beats a lift Proceed once', high: { priority: USER_PRIORITY_BASE, type: 'block' }, low: { priority: POPUP_LIFT_PRIORITY.allow, type: 'allow' }, winner: 'high' },
  { name: 'the lift redirect beats a block at the stock maximum', high: { priority: LIFT, type: 'redirect' }, low: { priority: STOCK_PRIORITY_MAX, type: 'block' }, winner: 'high' },
];

let decided: readonly (number | null)[] = [];

beforeAll(async () => {
  decided = await withExtensions([{ name: 'bands', rulesets: [], hostAccess: true }], async (workers) => {
    const w = workers.get('bands');
    if (w === undefined) throw new Error('extension did not start');
    return w.evaluate(async (pairs) => {
      const d = (globalThis as unknown as { chrome: { declarativeNetRequest: { updateDynamicRules: (o: object) => Promise<void>; testMatchOutcome: (r: object) => Promise<{ matchedRules: { ruleId: number }[] }> } } }).chrome.declarativeNetRequest;
      const rule = (id: number, host: string, r: { priority: number; type: string }) => ({
        id, priority: r.priority,
        action: r.type === 'redirect' ? { type: 'redirect', redirect: { regexSubstitution: 'https://blocked.invalid/#\\0' } } : { type: r.type },
        condition: { ...(r.type === 'redirect' ? { regexFilter: '^https?://.*' } : {}), requestDomains: [host], resourceTypes: ['main_frame'] },
      });
      await d.updateDynamicRules({ addRules: pairs.flatMap((p, i) => [rule(2 * i + 1, `h${String(i)}.example`, p.high), rule(2 * i + 2, `h${String(i)}.example`, p.low)]) });
      return Promise.all(pairs.map(async (_, i) => (await d.testMatchOutcome({ url: `https://h${String(i)}.example/`, type: 'main_frame', tabId: -1 })).matchedRules.find((m) => m.ruleId <= 2 * pairs.length)?.ruleId ?? null));
    }, PAIRS);
  });
}, LAUNCH_TIMEOUT_MS);

afterAll(() => {
  expectNoSurvivors();
});

describe('DNR priority bands in Chromium', () => {
  test.each(PAIRS.map((p, i) => [p.name, i] as const))('%s', (_name, i) => {
    expect(decided[i]).toBe(PAIRS[i]?.winner === 'high' ? 2 * i + 1 : 2 * i + 2);
  });
});
