/**
 * `cosmetic-generic` surveyor on the real build (P2-24, cosmetic notes §4–§5, performance notes §2): the infinite-scroll
 * fixture at Thorough — every `.ad-banner` hidden over a 20-page scroll session, and the gate "the
 * surveyor's scripting time ≤ 3 % of the test's main-thread time", measured with a CDP sampling profile
 * of the page (samples whose frame is one of our extension's scripts, over the profile's duration).
 * Load-sensitive: the measure and `uptime` go to the annotations.
 */
import { loadavg } from 'node:os';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createDefaultSettings } from '../../src/core/state/defaults.js';
import { loadFixtures, type FixtureEntry } from '../fixtures/manifest.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server/server.js';
import { closeAll, expectNoSurvivors } from './helpers/browser.js';
import { applySettings, createCorpusExtension, type CorpusExtension } from './helpers/corpus.js';
import { expectBudget } from './helpers/perf.js';
import { startSession, type Session } from './helpers/session.js';
import { PROPAGATION_WINDOW_MS, settleVisits } from './helpers/settle.js';

/** cosmetic notes §4: the surveyor's share of main-thread time on the infinite-scroll fixture. */
const MAX_SHARE = 0.03;
const SAMPLING_US = 100;
/** The fixture's own check is two scrolls; the gate's session is a longer feed, as a reader would scroll it. */
const SCROLLS = 20;
const POLL = { timeout: 10_000, intervals: [50, 100, 250] };

const SCROLL = ((): FixtureEntry => {
  const found = loadFixtures().find((f) => f.id === 'cosmetic-generic/infinite-scroll');
  if (found === undefined) throw new Error('cosmetic-generic/infinite-scroll missing');
  return found;
})();

let server: FixtureServer;
let extension: CorpusExtension;
const contexts = new Set<BrowserContext>();

test.beforeAll(async () => {
  server = await startFixtureServer();
  extension = await createCorpusExtension(loadFixtures());
});

test.afterEach(async () => {
  await Promise.all([...contexts].map((c) => c.close().catch(() => undefined)));
  contexts.clear();
  await closeAll();
});

test.afterAll(async () => {
  try {
    await (server as FixtureServer | undefined)?.close();
    await (extension as CorpusExtension | undefined)?.remove();
  } finally {
    await expectNoSurvivors();
  }
});

interface ProfileNode {
  readonly id: number;
  readonly callFrame: { readonly url: string };
  readonly children?: readonly number[];
}
interface Profile {
  readonly nodes: readonly ProfileNode[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
  readonly startTime: number;
  readonly endTime: number;
}

/** Self time per script URL (by sample) and the profile's duration, in µs. */
function timeByUrl(profile: Profile): { readonly byUrl: ReadonlyMap<string, number>; readonly total: number } {
  const urlOf = new Map(profile.nodes.map((n) => [n.id, n.callFrame.url]));
  const byUrl = new Map<string, number>();
  profile.samples.forEach((node, i) => {
    const url = urlOf.get(node) ?? '';
    byUrl.set(url, (byUrl.get(url) ?? 0) + (profile.timeDeltas[i] ?? 0));
  });
  return { byUrl, total: profile.endTime - profile.startTime };
}

/**
 * Time of the samples whose stack holds a frame of `url` (inclusive: the DOM calls it makes, such as
 * `querySelectorAll` and `insertRule`, are native frames without a URL), in µs.
 */
function inclusiveTime(profile: Profile, matches: (url: string) => boolean): number {
  const parent = new Map(profile.nodes.flatMap((n) => (n.children ?? []).map((c) => [c, n.id] as const)));
  const own = new Map(profile.nodes.map((n) => [n.id, matches(n.callFrame.url)]));
  const inside = (node: number | undefined): boolean => node !== undefined && ((own.get(node) ?? false) || inside(parent.get(node)));
  return profile.samples.reduce((sum, node, i) => sum + (inside(node) ? (profile.timeDeltas[i] ?? 0) : 0), 0);
}

/** The surveyor's own files: the script and the generic data it reads (not the other content scripts). */
const isSurveyor = (url: string, id: string): boolean => url === `chrome-extension://${id}/cosmetic-generic.js` || /^chrome-extension:\/\/[a-p]{32}\/cosmetic\/[a-z0-9-]+\/generic\.js$/.test(url);

const visibleBanners = (page: Page): Promise<number> =>
  page.evaluate(() => [...document.querySelectorAll('.ad-banner')].filter((e) => (e as HTMLElement).offsetHeight > 0).length);

async function scrollToEnd(page: Page): Promise<void> {
  const before = await page.evaluate(() => document.querySelectorAll('#feed > div').length);
  await page.evaluate(() => {
    scrollTo(0, document.body.scrollHeight);
  });
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('#feed > div').length), POLL).toBeGreaterThan(before);
}

/** Thorough on the fixture host, and the surveyor seen on a new load (a change may reach new loads late, `settle.ts`). */
async function thorough(): Promise<Session> {
  const s = await startSession(server, extension.dir, contexts);
  await applySettings(s.context, s.worker, s.id, { ...createDefaultSettings(), siteLevels: { [new URL(SCROLL.page).hostname]: 'thorough' } });
  const probe = await s.context.newPage();
  const seen = await settleVisits(async () => {
    await probe.goto(SCROLL.page, { waitUntil: 'load' });
    const hidden = await expect.poll(() => visibleBanners(probe), { timeout: 2_000 }).toBe(0).then(() => true, () => false);
    return { wanted: [true], actual: [hidden] };
  }, PROPAGATION_WINDOW_MS);
  expect(seen.actual, 'the surveyor reaches new loads after the level change').toEqual([true]);
  await probe.close();
  return s;
}

test('infinite scroll at Thorough: every ad box hidden after two scrolls; surveyor ≤ 3 % of main-thread time', async () => {
  const s = await thorough();
  const page = await s.context.newPage();
  // Short enough that the feed scrolls even after its ad boxes are hidden (20 items × 40 px).
  await page.setViewportSize({ width: 800, height: 300 });
  const cdp = await s.context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLING_US });
  await cdp.send('Profiler.start');
  await page.goto(SCROLL.page, { waitUntil: 'load' });
  for (let i = 0; i < SCROLLS; i += 1) await scrollToEnd(page);
  await expect.poll(() => visibleBanners(page), POLL).toBe(0);
  expect(await page.evaluate(() => document.querySelectorAll('.ad-banner').length)).toBeGreaterThanOrEqual(4 * (SCROLLS + 1));
  expect(await page.evaluate(() => [...document.querySelectorAll('.item')].every((e) => (e as HTMLElement).offsetHeight > 0))).toBe(true);
  const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: Profile };
  const { byUrl, total } = timeByUrl(profile);
  const ours = [...byUrl].filter(([url]) => isSurveyor(url, s.id)).reduce((sum, [, us]) => sum + us, 0);
  const share = ours / total;
  const extension = [...byUrl].filter(([url]) => url.startsWith(`chrome-extension://${s.id}/`)).map(([url, us]) => `${url.split('/').slice(3).join('/')} ${(us / 1000).toFixed(1)} ms`);
  test.info().annotations.push({ type: 'surveyor share', description: `${(share * 100).toFixed(2)} % (${(ours / 1000).toFixed(1)} of ${(total / 1000).toFixed(0)} ms); extension scripts: ${extension.join(', ')}; load average ${loadavg().map((l) => l.toFixed(2)).join(', ')}` });
  process.stdout.write(`surveyor share ${test.info().annotations.at(-1)?.description ?? ''}\n`);
  expect(share).toBeLessThanOrEqual(MAX_SHARE);
});

test('a class added after load is hidden; the frame is left alone at Standard', async () => {
  const s = await thorough();
  const page = await s.context.newPage();
  await page.goto(SCROLL.page, { waitUntil: 'load' });
  await page.evaluate(() => {
    const late = document.createElement('div');
    late.id = 'late';
    late.textContent = 'late';
    document.body.append(late);
    setTimeout(() => {
      late.className = 'ad-banner';
    }, 100);
  });
  await expect.poll(() => page.evaluate(() => document.getElementById('late')?.offsetHeight ?? -1), POLL).toBe(0);
  await applySettings(s.context, s.worker, s.id, createDefaultSettings());
  const back = await settleVisits(async () => {
    await page.reload({ waitUntil: 'load' });
    return { wanted: [true], actual: [(await visibleBanners(page)) > 0] };
  }, PROPAGATION_WINDOW_MS);
  expect(back.actual, 'at Standard the ad boxes are left alone').toEqual([true]);
});

/** performance notes §2.3: Thorough, initial survey of a 5,000-element page. */
const INITIAL_SURVEY_MS = 8;
const SURVEY_RUNS = 9;
/** The survey runs in 4 ms slices on animation frames after `document_idle`; this covers it with room. */
const SURVEY_IDLE_MS = 1_000;
const DOM_5000 = 'https://generic.example/perf/dom-5000.html';

const pctl = (v: readonly number[], q: number): number => [...v].sort((a, b) => a - b)[Math.ceil(v.length * q) - 1] ?? Infinity;

/**
 * One fresh load of the 5,000-element page under a 100 µs profile: the surveyor script's time. Its generic
 * data parse is P2-23's own row (here the corpus build's data is only the fixtures' filters).
 */
async function surveyOnce(s: Session): Promise<number> {
  const page = await s.context.newPage();
  const cdp = await s.context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLING_US });
  await cdp.send('Profiler.start');
  await page.goto(DOM_5000, { waitUntil: 'load' });
  await page.waitForTimeout(SURVEY_IDLE_MS);
  const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: Profile };
  expect(await page.evaluate(() => document.querySelectorAll('#root *').length)).toBeGreaterThanOrEqual(4_998);
  await page.close();
  return inclusiveTime(profile, (url) => url === `chrome-extension://${s.id}/cosmetic-generic.js`) / 1000;
}

test('Thorough: initial survey of a 5,000-element page ≤ 8 ms (record; asserted by test:perf)', { tag: '@perf' }, async () => {
  test.setTimeout(180_000);
  const s = await thorough();
  const script: number[] = [];
  for (let i = 0; i < SURVEY_RUNS; i += 1) script.push(await surveyOnce(s));
  const fmt = (v: readonly number[]): string => `median ${pctl(v, 0.5).toFixed(2)}, p95 ${pctl(v, 0.95).toFixed(2)} ms`;
  test.info().annotations.push({ type: 'initial survey', description: `n=${String(SURVEY_RUNS)}; surveyor script ${fmt(script)}; runs ${script.map((v) => v.toFixed(1)).join(' ')}; load average ${loadavg().map((l) => l.toFixed(2)).join(', ')}` });
  expect(Math.min(...script), 'the surveyor ran on the page').toBeGreaterThan(0);
  expectBudget('initial survey p95 (ms)', Number(pctl(script, 0.95).toFixed(2)), INITIAL_SURVEY_MS);
});
