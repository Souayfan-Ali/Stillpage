/**
 * Observing a fixture page (P1-42, shared by the corpus suite and the P1-46 journeys): each row of
 * `fixtures.json` names what to look at (a request the server saw or not, a page global, an attribute,
 * an element's visibility, a navigation) and the expected outcome. Observations settle within a few
 * frames (procedural passes, watched attributes, timers), so they are polled until they match or the
 * settle time runs out; the last reading is returned either way.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { FixtureEntry, Observation } from '../../fixtures/manifest.js';
import type { FixtureServer } from '../../fixtures/server/server.js';
import { PROPAGATION_WINDOW_MS, settleVisits, type Visit } from './settle.js';

const SETTLE = { timeout: 3_000, intervals: [50, 100, 100] };

const urlsOf = (server: FixtureServer): readonly string[] => server.log().map((r) => `https://${r.host}${r.path}`);

/** Opens `url` in a fresh tab: `loaded`, `blocked` (ERR_BLOCKED_BY_CLIENT) or the failure line. */
export async function navigate(context: BrowserContext, url: string): Promise<string> {
  const tab = await context.newPage();
  try {
    return await tab.goto(url).then(
      () => 'loaded',
      (error: unknown) => (String(error).includes('ERR_BLOCKED_BY_CLIENT') ? 'blocked' : `failed: ${String(error).split('\n')[0] ?? ''}`),
    );
  } finally {
    await tab.close();
  }
}

async function observe(server: FixtureServer, page: Page, observation: Observation): Promise<unknown> {
  if ('request' in observation) return urlsOf(server).includes(observation.request) ? 'loaded' : 'blocked';
  if ('global' in observation) return page.evaluate((name) => (window as unknown as Record<string, unknown>)[name] ?? null, observation.global);
  if ('attribute' in observation) return page.evaluate((name) => document.documentElement.getAttribute(name), observation.attribute);
  if ('element' in observation) return (await page.locator(observation.element).first().isVisible()) ? 'shown' : 'hidden';
  return navigate(page.context(), observation.navigation);
}

async function observeAll(server: FixtureServer, page: Page, expectations: readonly Observation[]): Promise<unknown[]> {
  const actual: unknown[] = [];
  for (const observation of expectations) actual.push(await observe(server, page, observation));
  return actual;
}

export type { Visit } from './settle.js';

/** Loads the fixture page once and reads every expectation, polling until they match or settle. */
export async function visit(server: FixtureServer, context: BrowserContext, fixture: FixtureEntry, expectations: readonly Observation[] = fixture.expect): Promise<Visit> {
  server.clearLog();
  const page = await context.newPage();
  try {
    await page.goto(fixture.page, { waitUntil: 'load' });
    if (fixture.setup?.click !== undefined) await page.click(fixture.setup.click);
    const wanted = expectations.map((o) => o.is);
    // A mismatch after the settle time is reported by the caller with the last reading.
    await expect
      .poll(() => observeAll(server, page, expectations), SETTLE)
      .toEqual(wanted)
      .catch(() => undefined);
    return { wanted, actual: await observeAll(server, page, expectations) };
  } finally {
    await page.close();
  }
}

/** `[observation, outcome]` rows, so a failure names the observation that differs. */
export function rows(expectations: readonly Observation[], outcomes: readonly unknown[]): readonly { observation: string; actual: unknown }[] {
  return expectations.map((o, i) => ({ observation: JSON.stringify(o), actual: outcomes[i] }));
}

/**
 * `afterChange`: the observation follows a state change (level, pause, access, update); the page is loaded
 * again until it matches, within `PROPAGATION_WINDOW_MS` (`settle.ts` says why). Every reload is recorded
 * as an annotation, so how often Chrome lags stays visible.
 */
export async function expectFixture(
  server: FixtureServer,
  context: BrowserContext,
  fixture: FixtureEntry,
  expectations: readonly Observation[] = fixture.expect,
  options: { readonly afterChange?: boolean } = {},
): Promise<void> {
  const once = (): Promise<Visit> => visit(server, context, fixture, expectations);
  const result = options.afterChange === true ? await settleVisits(once, PROPAGATION_WINDOW_MS) : { ...(await once()), visits: 1 };
  if (result.visits > 1) test.info().annotations.push({ type: 'change reached new loads', description: `${fixture.id}: after ${String(result.visits)} loads` });
  expect(rows(expectations, result.actual), fixture.id).toEqual(rows(expectations, result.wanted));
}
