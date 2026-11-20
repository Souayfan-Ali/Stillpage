/**
 * Helpers for the settings pages' journeys (P2-33…P2-38): open an extension page of the real build,
 * send a raw command from it, wait for the reconciler, read the enabled rulesets, and run axe-core
 * (colour contrast included) on the real CSS.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { expect, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { extensionWorker } from './browser.js';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
export const POLL = { timeout: 30_000, intervals: [100, 250, 500] };

export async function extensionIdOf(context: BrowserContext): Promise<string> {
  return new URL((await extensionWorker(context)).url()).host;
}

/** Opens `path` (`dashboard.html#sites`) of our extension in a new tab. */
export async function openPage(context: BrowserContext, path: string): Promise<Page> {
  const id = await extensionIdOf(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/${path}`);
  return page;
}

let counter = 0;
export function send(page: Page, type: string, payload: unknown): Promise<unknown> {
  counter += 1;
  return page.evaluate(([t, p, id]) => chrome.runtime.sendMessage({ v: 1, type: t, id, payload: p }), [type, payload, `e2e${String(counter)}`] as const);
}

/** Waits until a reconcile run answers (the install run is done). */
export async function settled(page: Page): Promise<void> {
  await expect.poll(() => send(page, 'c/reconcile', {}), POLL).toMatchObject({ ok: true });
}

export const enabledRulesets = (page: Page): Promise<string[]> => page.evaluate(async () => (await chrome.declarativeNetRequest.getEnabledRulesets()).sort());

/**
 * Page-wide best-practice rules whose verdict belongs to the top document. axe itself combines them across
 * frames (one `<main>` / `<h1>` anywhere on the page passes); a frame we check on its own (the picker panel,
 * inside a closed shadow root that axe cannot enter from the web page) is not held to them.
 */
const PAGE_WIDE_RULES = ['landmark-one-main', 'page-has-heading-one'] as const;

/** axe-core's WCAG 2.2 A/AA and best-practice rules on `target`: a page, or a frame such as the picker panel's. */
async function axeViolations(target: Page | Frame): Promise<string[]> {
  const isFrame = 'parentFrame' in target && target.parentFrame() !== null;
  const off = isFrame ? PAGE_WIDE_RULES : [];
  await target.evaluate(await AXE_SOURCE);
  return target.evaluate(async (disabled) => {
    const { axe } = window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } };
    const rules = Object.fromEntries(disabled.map((id) => [id, { enabled: false }]));
    const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules });
    return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, off);
}

/** axe in light and dark, with reduced motion; `frame` (default: the page itself) is what axe checks. */
export async function expectAccessible(page: Page, frame: Page | Frame = page): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    expect(await axeViolations(frame), colorScheme).toEqual([]);
  }
}

/**
 * The manual theme setting against the system one (tokens.css `data-theme`): dark chosen on a light system
 * and light chosen on a dark one, axe on each. The attribute is restored afterwards.
 */
export async function expectThemeOverrides(page: Page, frame: Page | Frame = page): Promise<void> {
  const before = await frame.evaluate(() => document.documentElement.getAttribute('data-theme'));
  for (const [colorScheme, theme] of [['light', 'dark'], ['dark', 'light']] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await frame.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
    expect(await axeViolations(frame), `${theme} on a ${colorScheme} system`).toEqual([]);
  }
  await frame.evaluate((b) => { if (b === null) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', b); }, before);
}
