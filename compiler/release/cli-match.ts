/**
 * `npm run release -- match --zip <release zip> --url <url> [--url …] [--type main_frame]` (P2-51 drills):
 * loads the release's rulesets (default state) in Playwright's Chromium and prints, per URL, whether it is
 * blocked, from `testMatchOutcome`. Exit 0. Local only: nothing is fetched, the URLs are only matched.
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { parseLedger, serialiseLedger } from '../postpass/ledger.js';
import { matchExtension, outcomeOf, withBadRule, type MatchedRule } from './match.js';
import { readZip } from './zip.js';

const WORKER_TIMEOUT_MS = 15_000;

interface Feedback { readonly testMatchOutcome: (r: { url: string; type: string; tabId: number }) => Promise<{ matchedRules: MatchedRule[] }> }

export async function matchCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: { zip: { type: 'string' }, url: { type: 'string', multiple: true, default: [] }, type: { type: 'string', default: 'main_frame' } } });
  if (values.zip === undefined || values.url.length === 0) throw new Error('--zip and at least one --url are required');
  const entries = readZip(new Uint8Array(await readFile(values.zip)));
  const files = matchExtension(entries);
  const rules = new Map([...files].filter(([p]) => p.startsWith('rulesets/')).map(([p, d]) => [path.basename(p, '.json'), JSON.parse(new TextDecoder().decode(d)) as object[]]));
  const work = await mkdtemp(path.join(tmpdir(), 'glassmere-drill-'));
  try {
    const ext = path.join(work, 'ext');
    for (const [name, data] of files) {
      await mkdir(path.dirname(path.join(ext, name)), { recursive: true });
      await writeFile(path.join(ext, name), data);
    }
    const context = await chromium.launchPersistentContext(path.join(work, 'profile'), { channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: WORKER_TIMEOUT_MS });
      for (const url of values.url) {
        const matched = await worker.evaluate(async (q) => (await (globalThis as unknown as { chrome: { declarativeNetRequest: Feedback } }).chrome.declarativeNetRequest.testMatchOutcome({ ...q, tabId: -1 })).matchedRules,
          { url, type: values.type });
        process.stdout.write(`${JSON.stringify({ url, type: values.type, outcome: outcomeOf(matched, rules), matched })}\n`);
      }
    } finally {
      await context.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** `release -- drill-bad-rule --zip <zip> --out <dir> --ledger <ubo ledger file> --host <host>` (P2-51 drill input). */
export async function drillBadRuleCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: { zip: { type: 'string' }, out: { type: 'string' }, ledger: { type: 'string' }, host: { type: 'string' } } });
  if (values.zip === undefined || values.out === undefined || values.ledger === undefined || values.host === undefined) throw new Error('--zip, --out, --ledger and --host are required');
  const ledger = parseLedger(await readFile(values.ledger, 'utf8'), values.ledger);
  const out = withBadRule(readZip(new Uint8Array(await readFile(values.zip))), ledger, values.host);
  for (const [name, data] of out.rulesets) {
    await mkdir(path.dirname(path.join(values.out, name)), { recursive: true });
    await writeFile(path.join(values.out, name), data);
  }
  await writeFile(values.ledger, serialiseLedger(out.ledger));
  process.stdout.write(`drill: bad rule ${String(ledger.nextId)} blocks ${values.host} documents in ${ledger.ruleset}\n`);
}
