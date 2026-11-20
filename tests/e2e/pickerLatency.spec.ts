/**
 * performance notes §2.4 "Picker: gesture → overlay ready ≤ 300 ms" on the real build (P2-47 follow-up): the toolbar
 * panel (a popup window, as J8), a click on "Hide something", then the worker's real `c/startPicker`
 * (session record, `executeScript` of `picker.js`, `x/pickerStart`) until the overlay host is attached to
 * the page and one animation frame later (painted). Both pages and the test stamp `Date.now()`, one system
 * clock (`performance.timeOrigin` differed between the two renderers by several ms). The budget is asserted
 * on the conservative figure: from the test issuing the click (input dispatch included) to the frame after
 * the host is attached. Record-only and load-sensitive (`@perf`, `npm run test:perf`).
 */
import { loadavg } from 'node:os';
import type { Page } from '@playwright/test';
import { test } from './fixtures.js';
import { openHidePage, openPanel } from './helpers/hider.js';
import { expectBudget } from './helpers/perf.js';

const RUNS = 9;
const OVERLAY_MS = 300;

/** Page world, before the page's scripts: when the picker's host element joins `<html>`, and the frame after. */
const WATCH = (): void => {
  const w = self as unknown as { __overlay?: { attached: number; painted?: number } };
  const now = (): number => Date.now();
  new MutationObserver(() => {
    if (w.__overlay !== undefined || ((document.documentElement as HTMLElement | null)?.children.length ?? 0) < 3) return;
    const mark = { attached: now() } as { attached: number; painted?: number };
    w.__overlay = mark;
    requestAnimationFrame(() => {
      mark.painted = now();
    });
    // `<html>` does not exist yet when an init script runs: watch the document.
  }).observe(document, { childList: true, subtree: true });
};

const pctl = (v: readonly number[], q: number): number => [...v].sort((a, b) => a - b)[Math.ceil(v.length * q) - 1] ?? Infinity;
const stat = (v: readonly number[]): string => `median ${pctl(v, 0.5).toFixed(0)}, p95 ${pctl(v, 0.95).toFixed(0)} ms`;

/** One gesture: from the click event in the panel to the overlay's marks in the page, and from the test's click to its frame. */
async function once(page: Page, panel: Page): Promise<{ readonly attached: number; readonly painted: number; readonly issued: number }> {
  const button = panel.getByRole('button', { name: 'Hide something' });
  await button.waitFor();
  await button.evaluate((el) => {
    el.addEventListener('click', () => {
      (self as unknown as { __gesture?: number }).__gesture = Date.now();
    }, { capture: true, once: true });
  });
  const issued = Date.now();
  await button.click();
  await page.waitForFunction(() => (self as unknown as { __overlay?: { painted?: number } }).__overlay?.painted !== undefined, null, { timeout: 10_000 });
  const gesture = await panel.evaluate(() => (self as unknown as { __gesture?: number }).__gesture ?? NaN).catch(() => NaN);
  const marks = await page.evaluate(() => (self as unknown as { __overlay: { attached: number; painted: number } }).__overlay);
  return { attached: marks.attached - gesture, painted: marks.painted - gesture, issued: marks.painted - issued };
}

test('picker: gesture → overlay ready ≤ 300 ms (record; asserted by test:perf)', { tag: '@perf' }, async ({ context, serviceWorker }) => {
  test.setTimeout(240_000);
  await context.addInitScript(WATCH);
  const page = await openHidePage(context);
  const runs: { attached: number; painted: number; issued: number }[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    await page.reload();
    await page.bringToFront();
    const panel = await openPanel(context, serviceWorker);
    // The click may close the panel window before its stamp is read: read it first, in `once`.
    runs.push(await once(page, panel));
    if (!panel.isClosed()) await panel.close();
  }
  const attached = runs.map((r) => r.attached).filter(Number.isFinite);
  const painted = runs.map((r) => r.painted).filter(Number.isFinite);
  const issued = runs.map((r) => r.issued);
  test.info().annotations.push({ type: 'picker overlay', description: `n=${String(painted.length)}/${String(RUNS)}; host attached ${stat(attached)}; painted (next frame) ${stat(painted)}; test click → painted ${stat(issued)}; load average ${loadavg().map((l) => l.toFixed(2)).join(', ')}` });
  expectBudget('picker test click → overlay painted p95 (ms)', Math.round(pctl(issued, 0.95)), OVERLAY_MS);
});
