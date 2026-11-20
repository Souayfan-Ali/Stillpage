import { describe, expect, test } from 'vitest';
import type { Hostname } from '../../../../src/core/ids.js';
import { remedyAvailability } from '../../../../src/core/breakage/ladders.js';
import { startFlow, tryRemedy } from '../../../../src/core/breakage/machine.js';
import { FLOW_TTL_MS, flowKey, readFlow } from '../../../../src/core/breakage/storage.js';

const NOW = 1_800_000_000_000;
const HOST = 'news.example.com' as Hostname;
const PLAIN = { ownLevel: null, popupPolicy: null, pausedUntil: null };
const started = startFlow('broken', { tabId: 3, host: HOST, popupBlocked: false, availability: {}, now: NOW }).state;
/** What `storage.session` hands back: a structured clone, read as untrusted input. */
const roundTrip = (x: unknown): unknown => JSON.parse(JSON.stringify(x));

describe('readFlow (state survives reload)', () => {
  test('a stored state comes back for the same tab and host', () => {
    expect(readFlow(roundTrip(started), 3, HOST, NOW + 1)).toEqual({ kind: 'active', state: started });
  });

  test('a pending trial survives the reload, so the panel reopens at "After the reload"', () => {
    const waiting = tryRemedy(started, 'light', PLAIN, NOW).state;
    expect(readFlow(roundTrip(waiting), 3, HOST, NOW + 1)).toEqual({ kind: 'active', state: waiting });
  });

  test('another host on the same tab: not applicable, but not discarded (sign-in round trip)', () => {
    expect(readFlow(roundTrip(started), 3, 'login.example.org' as Hostname, NOW)).toEqual({ kind: 'not-applicable' });
  });

  test('older than the TTL since the last transition: discarded, and an unanswered trial is handed back', () => {
    const waiting = tryRemedy(started, 'light', PLAIN, NOW).state;
    expect(readFlow(roundTrip(waiting), 3, HOST, NOW + FLOW_TTL_MS + 1)).toEqual({ kind: 'discard', orphan: waiting.trial });
    expect(readFlow(roundTrip(started), 3, HOST, NOW + FLOW_TTL_MS + 1)).toEqual({ kind: 'discard', orphan: null });
    expect(readFlow(roundTrip(started), 3, HOST, NOW + FLOW_TTL_MS).kind).toBe('active');
  });

  test.each([
    ['nothing stored', undefined],
    ['not an object', 'x'],
    ['other version', { ...started, v: 2 }],
    ['other tab', { ...started, tabId: 4 }],
    ['bad host', { ...started, host: 'Not A Host' }],
    ['unknown complaint', { ...started, complaint: 'other' }],
    ['step out of range', { ...started, step: 9 }],
    ['extra field', { ...started, extra: 1 }],
    ['prototype key', JSON.parse('{"__proto__":{"x":1}}') as unknown],
    ['remedy outside the ladder', { ...started, trial: { remedy: 'pause', applied: null, previous: null } }],
    ['waiting without a trial', { ...started, phase: 'await' }],
    ['offering with a trial', { ...started, trial: { remedy: 'light', applied: null, previous: null } }],
    ['future timestamp', { ...started, updatedAt: NOW + 1 }],
  ])('invalid (%s) → discard without an orphan', (_name, raw) => {
    const r = readFlow(roundTrip(raw ?? null), 3, HOST, NOW);
    expect(r).toEqual({ kind: 'discard', orphan: null });
  });

  test('flowKey is per tab', () => {
    expect(flowKey(3)).toBe('breakage:3');
  });
});

describe('remedyAvailability', () => {
  const at = (level: 'off' | 'light' | 'standard' | 'thorough', setOn: Hostname | null = null) => ({ level, setOn, pausedUntil: null });
  test.each([
    ['light', { level: at('standard') }, 'available'],
    ['light', { level: at('light') }, 'noop'],
    ['light', { level: at('off') }, 'noop'],
    ['off', { level: at('light') }, 'available'],
    ['off', { level: at('off') }, 'noop'],
    ['thorough', { level: at('standard') }, 'available'],
    ['thorough', { level: at('thorough') }, 'noop'],
    ['thorough', { level: at('standard', 'example.com' as Hostname) }, 'capped-by-parent'],
    ['thorough', { level: at('standard', HOST) }, 'available'],
    ['thorough', { level: at('standard'), siteAccess: false }, 'needs-site-access'],
    ['pause', { level: at('standard') }, 'available'],
    ['pause', { level: at('off') }, 'noop'],
    ['allowPopups', { level: at('standard'), popupPolicy: 'allow' as const }, 'noop'],
    ['allowPopups', { level: at('standard') }, 'available'],
    ['reload', { level: at('off') }, 'available'],
    ['picker', { level: at('off') }, 'available'],
    ['strictPopups', { level: at('standard') }, 'available'],
    ['strictPopups', { level: at('standard'), popupPolicy: 'strict' as const }, 'noop'],
    ['strictPopups', { level: at('standard'), guardShipped: false }, 'needs-guard'],
  ] as const)('%s with %j → %s', (remedy, over, expected) => {
    expect(remedyAvailability(remedy, { host: HOST, siteAccess: true, popupPolicy: null, guardShipped: true, ...over })).toBe(expected);
  });
});
