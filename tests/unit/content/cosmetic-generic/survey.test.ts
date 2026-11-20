// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { createMatcher, tokensOf } from '../../../../src/content/cosmetic-generic/matcher.js';
import { runGenericSurvey, SLICE_MS, STATE_KEY, surveyBatch, surveyStats, type SheetLike, type SurveyEnv } from '../../../../src/content/cosmetic-generic/survey.js';
import { GENERIC_QUEUE, type GenericData } from '../../../../src/core/generic/data.js';
import { leadingToken, tokenHash } from '../../../../src/core/generic/token.js';
import type { Hostname } from '../../../../src/core/ids.js';

/** A generic data file as the compiler writes it (sorted selectors, token index, always list). */
function data(selectors: readonly string[], extra: Partial<GenericData> = {}): GenericData {
  const sorted = [...selectors].sort();
  const tokens: Record<string, number[]> = {};
  const always: number[] = [];
  sorted.forEach((s, i) => {
    const t = leadingToken(s);
    if (t === null) always.push(i);
    else (tokens[String(tokenHash(t))] ??= []).push(i);
  });
  return { v: 1, pack: 'ads', selectors: sorted, tokens, always, unhide: [], exceptions: [], off: [], ...extra };
}

const HOST = 'news.example' as Hostname;

describe('createMatcher (P2-24)', () => {
  test('tokens look up their selectors once; always-on selectors; unhide and host exceptions subtracted', () => {
    const ads = data(['.ad-banner', '#top-ad', '.sponsor > a', 'div[data-ad]', '.kept'], { exceptions: [['example', ['.kept']]] });
    const other = data(['.ad-banner', '.promo'], { pack: 'trackers', unhide: ['.promo'] });
    const m = createMatcher([ads, other, 'junk'], HOST);
    expect(m?.always).toEqual(['div[data-ad]']);
    expect(m?.match(['.ad-banner', '#top-ad', '.promo', '.kept', '.none'])).toEqual(['.ad-banner', '#top-ad']);
    expect(m?.match(['.ad-banner', '.sponsor'])).toEqual(['.sponsor > a']);
    expect(m?.match(['.sponsor'])).toEqual([]);
  });

  test('nothing to do: no valid data, or $generichide on the host or a parent', () => {
    expect(createMatcher([{ v: 2 }], HOST)).toBeNull();
    expect(createMatcher([data(['.a'], { off: ['example'] })], HOST)).toBeNull();
    expect(createMatcher([data(['.a'], { off: ['other.example'] })], HOST)).not.toBeNull();
  });

  test('tokensOf: id and class attribute values in lookup form; non-strings ignored', () => {
    expect(tokensOf('x', ' a\tb  ')).toEqual(['#x', '.a', '.b']);
    expect(tokensOf(null, null)).toEqual([]);
    expect(tokensOf({}, 7)).toEqual([]);
  });
});

interface Rig {
  readonly env: SurveyEnv;
  readonly rules: string[];
  readonly frames: (() => void)[];
  tick: (ms: number) => void;
  hidden: boolean;
  visibility: ((event: { readonly isTrusted: boolean }) => void) | null;
}

/** The entry's DOM port, with this world's prototype methods (as `src/entrypoints/cosmetic-generic.ts`). */
const getAttribute = Object.getOwnPropertyDescriptor(Element.prototype, 'getAttribute')?.value as (this: Element, name: string) => string | null;
const querySelectorAll = Object.getOwnPropertyDescriptor(Element.prototype, 'querySelectorAll')?.value as (this: Element, selectors: string) => NodeListOf<Element>;
const DOM = {
  isElement: (node: unknown): node is object => node instanceof Element,
  attribute: (el: object, name: 'id' | 'class') => getAttribute.call(el as Element, name),
  descendants: (el: object, selector: string) => querySelectorAll.call(el as Element, selector),
};

function rig(queue: unknown, viewport = { width: 800, height: 600 }): Rig {
  const rules: string[] = [];
  const frames: (() => void)[] = [];
  let clock = 0;
  const scope: Record<string, unknown> = { [GENERIC_QUEUE]: queue };
  const r: Rig = {
    rules,
    frames,
    hidden: false,
    visibility: null,
    tick: (ms) => {
      clock += ms;
    },
    env: undefined as unknown as SurveyEnv,
  };
  const sheet = (): SheetLike => ({
    insertRule: (rule, index) => {
      rules.splice(index, 0, rule);
      return index;
    },
    get cssRules() {
      return { length: rules.length };
    },
  });
  const doc = {
    documentElement: document.documentElement,
    get visibilityState() {
      return r.hidden ? 'hidden' : 'visible';
    },
    adoptedStyleSheets: [] as readonly unknown[],
    addEventListener: (_type: 'visibilitychange', listener: (event: { readonly isTrusted: boolean }) => void) => {
      r.visibility = listener;
    },
  };
  (r as { env: SurveyEnv }).env = {
    scope,
    document: doc,
    location: { hostname: 'www.news.example', origin: 'https://www.news.example' },
    viewport: () => viewport,
    clock: { now: () => clock, frame: (cb) => frames.push(cb), timeout: (cb) => frames.push(cb) },
    newObserver: (cb) => new MutationObserver((records) => {
      cb(records);
    }),
    newSheet: sheet,
    dom: DOM,
  };
  return r;
}

const runFrames = (r: Rig): void => {
  const f = r.frames.splice(0);
  f.forEach((cb) => {
    cb();
  });
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('runGenericSurvey (P2-24)', () => {
  test('hides matched elements present at idle and added later; one adopted sheet; the queue is taken', async () => {
    document.body.innerHTML = '<div class="content">x</div><div class="ad-banner">ad</div>';
    const r = rig([data(['.ad-banner', '.late-ad', 'div[data-ad]'])]);
    expect(runGenericSurvey(r.env)).toBe(1);
    expect(r.env.document.adoptedStyleSheets).toHaveLength(1);
    expect(Object.hasOwn(r.env.scope, GENERIC_QUEUE)).toBe(false);
    runFrames(r);
    expect(r.rules).toEqual(['div[data-ad]{display:none!important}', '.ad-banner{display:none!important}']);
    const late = document.createElement('section');
    late.innerHTML = '<p class="late-ad">x</p>';
    document.body.append(late);
    await new Promise((resolve) => setTimeout(resolve, 0));
    runFrames(r);
    expect(r.rules).toContain('.late-ad{display:none!important}');
  });

  test('a batch stops after the 4 ms slice and carries the rest to the next frame', () => {
    document.body.innerHTML = Array.from({ length: 300 }, (_, i) => `<div class="c${String(i)}"></div>`).join('') + '<div class="ad-banner"></div>';
    const r = rig([data(['.ad-banner'])]);
    runGenericSurvey(r.env);
    const survey = Reflect.get(r.env.scope, STATE_KEY) as Parameters<typeof surveyBatch>[0];
    let calls = 0;
    const now = (): number => (calls += 1) * (SLICE_MS / 2);
    expect(surveyBatch(survey, now)).toBe(true);
    expect(r.rules).toEqual([]);
    while (surveyBatch(survey, now));
    expect(r.rules).toEqual(['.ad-banner{display:none!important}']);
  });

  test('hidden tab: no work while hidden, one full rescan when visible again', async () => {
    document.body.innerHTML = '<div class="x"></div>';
    const r = rig([data(['.ad-banner'])]);
    runGenericSurvey(r.env);
    runFrames(r);
    r.hidden = true;
    r.visibility?.({ isTrusted: true });
    const ad = document.createElement('div');
    ad.className = 'ad-banner';
    document.body.append(ad);
    await new Promise((resolve) => setTimeout(resolve, 0));
    runFrames(r);
    expect(r.rules).toEqual([]);
    r.hidden = false;
    r.visibility?.({ isTrusted: true });
    runFrames(r);
    expect(r.rules).toEqual(['.ad-banner{display:none!important}']);
  });

  test('early exits: generichide host, tiny frame, no data, second run in the same frame, no adoptedStyleSheets', () => {
    expect(runGenericSurvey(rig([data(['.a'], { off: ['news.example'] })]).env)).toBe(-1);
    expect(runGenericSurvey(rig([data(['.a'])], { width: 1, height: 600 }).env)).toBe(-1);
    expect(runGenericSurvey(rig('not an array').env)).toBe(-1);
    const r = rig([data(['.a'])]);
    expect(runGenericSurvey(r.env)).toBe(0);
    Reflect.set(r.env.scope, GENERIC_QUEUE, [data(['.b'])]);
    expect(runGenericSurvey(r.env)).toBe(-1);
    const noAdopt = rig([data(['.a'])]);
    delete (noAdopt.env.document as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
    expect(runGenericSurvey(noAdopt.env)).toBe(-1);
  });

  test('a selector Chrome refuses does not stop the others; an unsafe selector is never inserted', () => {
    document.body.innerHTML = '<div class="a"></div><div class="b"></div>';
    const r = rig([data(['.a:-webkit-unknown-thing', '.b'])]);
    const original = r.env.newSheet;
    (r.env as { newSheet: () => SheetLike }).newSheet = () => {
      const s = original();
      return { insertRule: (rule, i) => (rule.includes('unknown') ? (() => { throw new Error('refused'); })() : s.insertRule(rule, i)), get cssRules() { return s.cssRules; } };
    };
    runGenericSurvey(r.env);
    runFrames(r);
    expect(r.rules).toEqual(['.b{display:none!important}']);
  });

  test('a class added later is surveyed (attribute changes observed); counters for the perf gate', async () => {
    document.body.innerHTML = '<div id="slot"></div>';
    const r = rig([data(['.ad-banner'])]);
    runGenericSurvey(r.env);
    runFrames(r);
    document.getElementById('slot')?.classList.add('ad-banner');
    await new Promise((resolve) => setTimeout(resolve, 0));
    runFrames(r);
    expect(r.rules).toEqual(['.ad-banner{display:none!important}']);
    const stats = surveyStats(Reflect.get(r.env.scope, STATE_KEY) as Parameters<typeof surveyStats>[0]);
    expect(stats).toMatchObject({ batches: 2, carried: 0, backoffs: 0, intervalMs: 0 });
  });

  test('DOM clobbering: a form shadowing id, classList and querySelectorAll does not stop the survey', async () => {
    document.body.innerHTML = '<div class="x"></div>';
    const r = rig([data(['.ad-banner'])]);
    runGenericSurvey(r.env);
    runFrames(r);
    const section = document.createElement('section');
    section.innerHTML = '<form class="ad-banner"><input name="id"><input name="classList"><input name="querySelectorAll"><input name="getAttribute"></form><p class="ad-banner">after</p>';
    document.body.append(section);
    await new Promise((resolve) => setTimeout(resolve, 0));
    runFrames(r);
    expect(r.rules).toEqual(['.ad-banner{display:none!important}']);
  });

  test('an untrusted visibilitychange (page script) and one without a real change are ignored', () => {
    document.body.innerHTML = '<div class="x"></div>';
    const r = rig([data(['.ad-banner'])]);
    runGenericSurvey(r.env);
    runFrames(r);
    const survey = Reflect.get(r.env.scope, STATE_KEY) as { pending: unknown[] };
    r.visibility?.({ isTrusted: false });
    r.visibility?.({ isTrusted: true });
    expect(survey.pending).toEqual([]);
    expect(r.frames).toEqual([]);
  });

  test('a class toggled many times is queued once; the queue is bounded', async () => {
    document.body.innerHTML = '<div id="spin"></div>';
    const r = rig([data(['.ad-banner'])]);
    runGenericSurvey(r.env);
    runFrames(r);
    const spin = document.getElementById('spin');
    for (let i = 0; i < 50; i += 1) spin?.setAttribute('class', `s${String(i)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const survey = Reflect.get(r.env.scope, STATE_KEY) as { pending: unknown[] };
    expect(survey.pending).toHaveLength(1);
  });

  test('a document with more classed elements than the queue bound is still surveyed (J15 huge DOM, P2-44)', () => {
    // Arrange: an ad first, then more classed elements than MAX_PENDING (50,000), as the hostile page's `__huge`
    const LARGER_THAN_QUEUE_BOUND = 50_010;
    const MAX_BATCHES = 5_000;
    const ad = document.createElement('div');
    ad.className = 'ad-banner';
    const filler = Array.from({ length: LARGER_THAN_QUEUE_BOUND }, (_, i) => {
      const span = document.createElement('span');
      span.className = `u${String(i)}`;
      return span;
    });
    document.body.replaceChildren(ad, ...filler);
    const r = rig([data(['.ad-banner'])]);
    runGenericSurvey(r.env);
    const survey = Reflect.get(r.env.scope, STATE_KEY) as Parameters<typeof surveyBatch>[0];
    let calls = 0;
    const now = (): number => (calls += 1) * (SLICE_MS / 4);

    // Act: the first batches reach the ad (the root's expansion is lazy, so the bound cannot restart it forever)
    for (let i = 0; i < 3; i += 1) surveyBatch(survey, now);
    expect(r.rules).toEqual(['.ad-banner{display:none!important}']);
    let batches = 3;
    while (surveyBatch(survey, now) && batches < MAX_BATCHES) batches += 1;

    // Assert: and the whole document is surveyed in bounded time
    expect(batches).toBeLessThan(MAX_BATCHES);
    expect(surveyBatch(survey, now)).toBe(false);
  }, 60_000);

  test('injected into a hidden tab: nothing runs until it is shown, then the document is surveyed', () => {
    document.body.innerHTML = '<div class="ad-banner"></div>';
    const r = rig([data(['.ad-banner'])]);
    r.hidden = true;
    runGenericSurvey(r.env);
    runFrames(r);
    expect(r.rules).toEqual([]);
    r.hidden = false;
    r.visibility?.({ isTrusted: true });
    runFrames(r);
    expect(r.rules).toEqual(['.ad-banner{display:none!important}']);
  });
});
