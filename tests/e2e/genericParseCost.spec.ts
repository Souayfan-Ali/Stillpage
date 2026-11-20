/**
 * P2-23 (cosmetic notes §5, design review): parse + evaluate cost per frame of the generic cosmetic data files the
 * build packages (`cosmetic/<pack>/generic.js`), per pack and for every default pack together, at 1×
 * and 4× CPU. Run as page scripts in plain Chromium, like P1-37's code-file measure: the isolated
 * world's own entry cost is Chrome's and is measured by the surveyor (P2-24). Record-only: numbers go
 * to the annotations and to `dist/perf/generic-parse-cost.json` (read by P2-25 for the Thorough
 * toggle); the gate is the size budget. Load-sensitive: note `uptime` beside the numbers.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
import { BUILD_DIR } from './helpers/fixtureExtension.js';

const LOADS = 30;
const RATES = [1, 4] as const;
const OUT_FILE = path.resolve(import.meta.dirname, '../../dist/perf/generic-parse-cost.json');

interface Catalog { readonly packs: Readonly<Record<string, { readonly default?: boolean }>> }
interface Cost { readonly median: number; readonly p95: number }

const pctl = (values: readonly number[], q: number): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] ?? Infinity;
const round = (ms: number): number => Math.round(ms * 100) / 100;

async function dataFiles(): Promise<{ readonly perPack: ReadonlyMap<string, string>; readonly defaults: readonly string[] }> {
  const catalog = JSON.parse(await readFile(path.join(BUILD_DIR, 'catalog.json'), 'utf8')) as Catalog;
  const packs = Object.keys(catalog.packs).sort();
  const texts = await Promise.all(packs.map(async (p) => [p, await readFile(path.join(BUILD_DIR, `cosmetic/${p}/generic.js`), 'utf8').catch(() => null)] as const));
  const perPack = new Map(texts.filter((e): e is readonly [string, string] => e[1] !== null));
  return { perPack, defaults: packs.filter((p) => catalog.packs[p]?.default === true && perPack.has(p)) };
}

async function measure(page: Page, text: string): Promise<Cost> {
  await page.unrouteAll();
  const body = `<!doctype html><title>t</title><script>const a=performance.now();\n${text}\nself.__parse=performance.now()-a;</script>`;
  await page.route('https://generic.example/', (route) => route.fulfill({ body, contentType: 'text/html' }));
  const out: number[] = [];
  for (let i = 0; i < LOADS; i += 1) {
    await page.goto('https://generic.example/');
    out.push(await page.evaluate(() => (self as unknown as { __parse: number }).__parse));
  }
  return { median: round(pctl(out, 0.5)), p95: round(pctl(out, 0.95)) };
}

test('generic data parse cost per frame at 1× and 4× CPU (record-only)', { tag: '@perf' }, async () => {
  test.setTimeout(300_000);
  const { perPack, defaults } = await dataFiles();
  expect(perPack.size).toBeGreaterThan(0);
  const cases = new Map([...perPack, ['default packs', defaults.map((p) => perPack.get(p) ?? '').join('\n')]]);
  const browser = await chromium.launch();
  const results: Record<string, Record<string, Cost & { readonly bytes: number }>> = {};
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    for (const rate of RATES) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      for (const [name, text] of cases) {
        results[name] = { ...results[name], [`${String(rate)}x`]: { ...(await measure(page, text)), bytes: text.length } };
      }
    }
  } finally {
    await browser.close();
  }
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify({ loads: LOADS, defaults, results }, null, 1)}\n`);
  test.info().annotations.push({ type: 'generic parse cost', description: JSON.stringify(results) });
  for (const byRate of Object.values(results)) for (const c of Object.values(byRate)) expect(Number.isFinite(c.p95)).toBe(true);
});
