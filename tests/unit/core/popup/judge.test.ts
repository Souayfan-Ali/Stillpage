import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { compileAllowlist } from '../../../../src/core/popup/allowlist.js';
import { GESTURE_WINDOW_MS, LARGE_TARGET_RATIO, LINK_CHECK_TIMEOUT_MS, NOTICE_ARM_DELAY_MS, OVERLAY_EDGE_TOLERANCE, OVERLAY_MAX_ALPHA, TAB_UNDER_WINDOW_MS } from '../../../../src/core/popup/constants.js';
import { destinationOf, judge, type Gesture, type GuardMode, type PopupRequest, type RuleCode } from '../../../../src/core/popup/judge.js';

const T0 = 1_000_000;
const PAGE = 'https://news.example.com/article/1';
const AD = 'https://ad.example.net/landing';
const ALLOW = compileAllowlist([{ host: 'accounts.google.com', pathPrefix: '/o/oauth2' }]);

/** A plain trusted click on an interactive control, nothing else. */
const gesture = (over: Partial<Gesture> = {}): Gesture =>
  ({ at: T0, modifier: false, targetInteractive: true, targetIsOverlay: false, link: null, openedCount: 0, ...over });
const request = (over: Partial<PopupRequest> = {}): PopupRequest =>
  ({ kind: 'open', target: 'new-context', url: AD, pageUrl: PAGE, at: T0 + 10, ...over });
const link = (href: string, hrefAtClick = href) => ({ hrefAtPointerDown: href, hrefAtClick, visible: true });

interface Row { readonly rule: RuleCode; readonly g: Gesture | null; readonly r: PopupRequest; readonly smart: 'allow' | 'block'; readonly strict: 'allow' | 'block' }

/** One row per line of pop-up notes §7.3, both modes. */
const ROWS: readonly Row[] = [
  { rule: 'G2', g: gesture(), r: request({ target: 'same-tab' }), smart: 'allow', strict: 'allow' },
  { rule: 'G2', g: gesture(), r: request({ target: 'existing-frame' }), smart: 'allow', strict: 'allow' },
  { rule: 'G3', g: gesture({ modifier: true, targetInteractive: false }), r: request(), smart: 'allow', strict: 'allow' },
  { rule: 'G4', g: gesture({ targetInteractive: false }), r: request({ url: 'https://www.example.com/x' }), smart: 'allow', strict: 'allow' },
  { rule: 'G4', g: null, r: request({ url: '/relative/path' }), smart: 'allow', strict: 'allow' },
  { rule: 'G5', g: gesture({ targetInteractive: false }), r: request({ url: 'https://accounts.google.com/o/oauth2/auth?x=1' }), smart: 'allow', strict: 'allow' },
  { rule: 'G6', g: gesture({ openedCount: 1 }), r: request(), smart: 'block', strict: 'block' },
  { rule: 'G7', g: gesture({ targetIsOverlay: true }), r: request(), smart: 'block', strict: 'block' },
  { rule: 'G8', g: gesture({ link: link(AD) }), r: request({ kind: 'link-click' }), smart: 'allow', strict: 'block' },
  { rule: 'G9', g: gesture({ link: link('https://video.example.org/watch') }), r: request(), smart: 'block', strict: 'block' },
  { rule: 'G10', g: gesture({ link: link(AD, 'https://other.example.org/') }), r: request(), smart: 'block', strict: 'block' },
  { rule: 'G11', g: gesture({ targetInteractive: false }), r: request(), smart: 'block', strict: 'block' },
  { rule: 'G12', g: null, r: request(), smart: 'allow', strict: 'block' },
  { rule: 'G13', g: gesture(), r: request(), smart: 'allow', strict: 'block' },
];

describe('judge: decision table (pop-up notes §7.3)', () => {
  test.each(ROWS.map((row) => [row.rule, row] as const))('%s', (_rule, row) => {
    expect(judge(row.g, row.r, 'smart', ALLOW)).toMatchObject({ verdict: row.smart, rule: row.rule });
    expect(judge(row.g, row.r, 'strict', ALLOW)).toMatchObject({ verdict: row.strict, rule: row.rule });
  });

  test('G1: mode off allows everything', () => {
    for (const row of ROWS) expect(judge(row.g, row.r, 'off', ALLOW)).toEqual({ verdict: 'allow', rule: 'G1' });
  });

  test('G7 asks to neutralise the overlay; other rows do not', () => {
    expect(judge(gesture({ targetIsOverlay: true }), request(), 'smart').neutraliseOverlay).toBe(true);
    expect(judge(gesture({ targetInteractive: false }), request(), 'smart').neutraliseOverlay).toBeUndefined();
  });

  test('G8 needs a trusted link click on a visible link to its own unchanged href', () => {
    expect(judge(gesture({ link: { ...link(AD), visible: false } }), request({ kind: 'link-click' }), 'smart').rule).toBe('G13');
    expect(judge(gesture({ link: link(AD) }), request({ kind: 'synthetic-click' }), 'smart').rule).toBe('G13');
    expect(judge(gesture({ link: link(AD) }), request({ kind: 'link-click', url: 'https://ad.example.net/other' }), 'smart').rule).toBe('G13');
  });

  test('a gesture older than the activation window counts as none (G12)', () => {
    expect(judge(gesture({ at: T0 - GESTURE_WINDOW_MS - 1 }), request({ at: T0 }), 'smart').rule).toBe('G12');
    expect(judge(gesture({ at: T0 - GESTURE_WINDOW_MS }), request({ at: T0 }), 'smart').rule).toBe('G13');
  });

  test('javascript: and fragment-only links are no link (G9 does not apply)', () => {
    expect(judge(gesture({ link: link('javascript:void(0)') }), request(), 'smart').rule).toBe('G13');
    expect(judge(gesture({ link: link('#top') }), request(), 'smart').rule).toBe('G13');
  });

  test('G5 matches a parsed https URL on a path-segment boundary only', () => {
    const at = (url: string): RuleCode => judge(gesture({ targetInteractive: false }), request({ url }), 'smart', ALLOW).rule;
    expect(at('https://accounts.google.com/o/oauth2')).toBe('G5');
    expect(at('https://accounts.google.com/o/oauth2x')).toBe('G11');
    expect(at('http://accounts.google.com/o/oauth2/auth')).toBe('G11');
    expect(at('https://accounts.google.com:8443/o/oauth2/auth')).toBe('G11');
    expect(at('https://evil.example/accounts.google.com/o/oauth2')).toBe('G11');
  });
});

describe('unknown destinations (S-20 treated open("") as same-site)', () => {
  test.each([[''], ['about:blank'], ['blob:null/123'], ['blob:blob:https://x.example/1'], ['data:text/html,hi'], ['javascript:alert(1)'], ['http://[bad']])(
    '%j is unknown: never G4, blocked by G11 on a non-interactive target',
    (url) => {
      expect(judge(gesture({ targetInteractive: false }), request({ url }), 'smart')).toMatchObject({ verdict: 'block', rule: 'G11' });
    },
  );

  test('a blob: URL counts as its inner http(s) origin (design review, P2-58): the page’s own blob is same-site (G4), an ad frame’s is not', () => {
    expect(judge(gesture({ targetInteractive: false }), request({ url: 'blob:https://news.example.com/7c1e' }), 'strict')).toMatchObject({ verdict: 'allow', rule: 'G4' });
    expect(judge(gesture({ targetInteractive: false }), request({ url: 'blob:https://ads.example.net/7c1e' }), 'strict')).toMatchObject({ verdict: 'block', rule: 'G11' });
    expect(destinationOf('blob:https://news.example.com/7c1e', PAGE)?.hostname).toBe('news.example.com');
    expect(destinationOf('blob:blob:https://news.example.com/7c1e', PAGE)).toBeNull(); // one blob: layer only (review LOW)
  });

  test('an unknown destination behind a real link is a link hijack (G9)', () => {
    expect(judge(gesture({ link: link('https://news.example.com/next') }), request({ url: 'about:blank' }), 'smart').rule).toBe('G9');
  });
});

describe('properties', () => {
  const href = fc.constantFrom('', 'about:blank', 'blob:x', 'data:,', '/p', 'https://www.example.com/a', AD, 'https://accounts.google.com/o/oauth2/x', 'https://x.example.org/', '#', 'javascript:0');
  const gestureArb: fc.Arbitrary<Gesture | null> = fc.option(fc.record({
    at: fc.integer({ min: T0 - 2 * GESTURE_WINDOW_MS, max: T0 }),
    modifier: fc.boolean(), targetInteractive: fc.boolean(), targetIsOverlay: fc.boolean(),
    link: fc.option(fc.record({ hrefAtPointerDown: href, hrefAtClick: href, visible: fc.boolean() }), { nil: null }),
    openedCount: fc.nat(3),
  }), { nil: null });
  const requestArb: fc.Arbitrary<PopupRequest> = fc.record({
    kind: fc.constantFrom('open', 'synthetic-click', 'link-click'),
    target: fc.constantFrom('new-context', 'same-tab', 'existing-frame'),
    url: href, pageUrl: fc.constantFrom(PAGE, 'about:blank'), at: fc.constant(T0),
  });
  const modes: readonly GuardMode[] = ['off', 'smart', 'strict'];

  test('G1–G5 never block, in any mode', () => {
    fc.assert(fc.property(gestureArb, requestArb, fc.constantFrom(...modes), (g, r, mode) => {
      const v = judge(g, r, mode, ALLOW);
      return !['G1', 'G2', 'G3', 'G4', 'G5'].includes(v.rule) || v.verdict === 'allow';
    }));
  });

  test('Strict blocks a superset of Smart', () => {
    fc.assert(fc.property(gestureArb, requestArb, (g, r) => judge(g, r, 'smart', ALLOW).verdict === 'allow' || judge(g, r, 'strict', ALLOW).verdict === 'block'));
  });

  test('off always allows with G1', () => {
    fc.assert(fc.property(gestureArb, requestArb, (g, r) => judge(g, r, 'off', ALLOW).rule === 'G1'));
  });
});

test('the named constants of pop-up notes §7.3', () => {
  expect([GESTURE_WINDOW_MS, LARGE_TARGET_RATIO, OVERLAY_EDGE_TOLERANCE, OVERLAY_MAX_ALPHA, TAB_UNDER_WINDOW_MS, NOTICE_ARM_DELAY_MS, LINK_CHECK_TIMEOUT_MS])
    .toEqual([5000, 0.5, 1 / 16, 0.05, 2000, 600, 50]);
});

test('destinationOf resolves relative URLs against the page and refuses unknown ones', () => {
  expect(destinationOf('/a?b', PAGE)?.href).toBe('https://news.example.com/a?b');
  expect(destinationOf(' ', PAGE)).toBeNull();
  expect(destinationOf('ftp://x.example/', PAGE)).toBeNull();
});
