/**
 * P1-37 timing (cosmetic notes §6.3, performance notes §2.3): the hardened dispatcher's own time before the first
 * scriptlet runs (≤ 0.3 ms), and the parse cost of the shared MAIN code file per frame, at 1× and 4×
 * CPU. Uses the build's real files: the largest MAIN data shard of the `ads` pack and its code file,
 * run as page scripts in plain Chromium (no extension: the extension's own injection cost is Chrome's
 * and is measured by P1-51 / the release perf gate). Recorded as annotations; only the wrapper
 * budget is asserted.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
import { BUILD_DIR } from './helpers/fixtureExtension.js';

const LOADS = 100;
const WRAPPER_BUDGET_MS = 0.3;

interface Registration { readonly id: string; readonly js: readonly string[]; readonly hosts: readonly string[] }

const pctl = (values: readonly number[], q: number): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] ?? Infinity;
const fmt = (values: readonly number[]): string => `p50 ${pctl(values, 0.5).toFixed(2)} / p95 ${pctl(values, 0.95).toFixed(2)} ms`;

async function largestMainShard(): Promise<{ data: string; code: string; host: string }> {
  const file = JSON.parse(await readFile(path.join(BUILD_DIR, 'registrations.json'), 'utf8')) as { packs: Record<string, Registration[]> };
  const mains = (file.packs['ads'] ?? []).filter((r) => r.id.startsWith('main:'));
  const sized = await Promise.all(mains.map(async (r) => ({ r, bytes: (await readFile(path.join(BUILD_DIR, r.js.at(-2) ?? ''), 'utf8')).length })));
  const best = sized.sort((a, b) => b.bytes - a.bytes)[0]?.r;
  if (best === undefined) throw new Error('no MAIN registration in the build');
  const texts = await Promise.all(best.js.map((p) => readFile(path.join(BUILD_DIR, p), 'utf8')));
  return { data: texts.slice(0, -1).join('\n'), code: texts.at(-1) ?? '', host: best.hosts[0] ?? '' };
}

/** Marks the dispatcher's start and the first scriptlet call inside the real code file. */
function instrument(code: string): string {
  const start = code.indexOf('];{', code.indexOf('const fns=['));
  const call = 'try{$apply(fns[';
  if (start < 0 || !code.includes(call)) throw new Error('code file layout changed: update the instrumentation');
  const marked = `${code.slice(0, start + 2)}self.__t0=performance.now();${code.slice(start + 2)}`;
  return marked.replace(call, 'if(self.__t1===void 0)self.__t1=performance.now();try{$apply(fns[');
}

async function series(page: Page, url: string, read: () => number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < LOADS; i += 1) {
    await page.goto(url);
    out.push(await page.evaluate(read));
  }
  return out;
}

test('dispatcher before the first scriptlet ≤ 0.3 ms; code-file parse cost at 1× and 4× CPU', { tag: '@perf' }, async () => {
  test.setTimeout(240_000);
  const { data, code, host } = await largestMainShard();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    const body = '<!doctype html><title>t</title><p>page</p>';
    await page.route(/^https:\/\/[^/]+\/$/, (route) => route.fulfill({ body, contentType: 'text/html' }));
    await page.addInitScript({ content: `if(location.hostname===${JSON.stringify(host)}){${data}\n${instrument(code)}}else{const a=performance.now();${code}\nself.__parse=performance.now()-a;}` });
    const results: string[] = [];
    let wrapper1x: number[] = [];
    for (const rate of [1, 4]) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      const wrapper = await series(page, `https://${host}/`, () => {
        const s = self as unknown as { __t0?: number; __t1?: number };
        return (s.__t1 ?? NaN) - (s.__t0 ?? NaN);
      });
      const parse = await series(page, 'https://unmatched.example/', () => (self as unknown as { __parse: number }).__parse);
      if (rate === 1) wrapper1x = wrapper;
      results.push(`${String(rate)}×: wrapper ${fmt(wrapper)}; code file (${String(code.length)} B) parse+run on an unmatched host ${fmt(parse)}`);
    }
    test.info().annotations.push({ type: 'scriptlets', description: `host ${host}, data ${String(data.length)} B; ${results.join('; ')}` });
    expect(wrapper1x.every((v) => Number.isFinite(v))).toBe(true);
    expect(pctl(wrapper1x, 0.95)).toBeLessThanOrEqual(WRAPPER_BUDGET_MS);
  } finally {
    await browser.close();
  }
});
