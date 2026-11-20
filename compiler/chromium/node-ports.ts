/**
 * The compiler's port to a real Chromium (Playwright's bundled build, the same one the E2E suite
 * uses): `isRegexSupported` for the regex gate and an unpacked load of the emitted rulesets
 * (P1-23). Throwaway extension and profile under `.cache/compiler/`; both are removed on close.
 * Every launch is closed in `finally`, so a failing call leaves no browser behind.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Worker } from '@playwright/test';
import { MIN_CHROME_VERSION } from '../../src/core/limits.js';
import type { DnrRule } from '../dnr/schema.js';
import type { RegexAnswer, RegexChecker, RegexQuery } from '../validate/regex.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WORK_DIR = path.join(ROOT, '.cache/compiler');
/** Profile prefix; `expectNoSurvivors`-style checks look for it. */
export const PROFILE_PREFIX = 'glassmere-compiler-';
const WORKER_TIMEOUT_MS = 15_000;
const EVALUATE_TIMEOUT_MS = 120_000;

/** One ruleset of the throwaway extension. */
export interface RulesetFile {
  readonly id: string;
  readonly rules: readonly DnrRule[];
}

/** Identity of the bundled Chromium (its Playwright revision directory). */
function chromiumId(): string {
  const parts = chromium.executablePath().split(path.sep);
  return parts.find((p) => /^chromium[-_]/.test(p)) ?? chromium.executablePath();
}

async function writeExtension(dir: string, rulesets: readonly RulesetFile[]): Promise<void> {
  await mkdir(path.join(dir, 'rules'), { recursive: true });
  for (const r of rulesets) await writeFile(path.join(dir, 'rules', `${r.id}.json`), JSON.stringify(r.rules));
  const manifest = {
    manifest_version: 3, name: 'compiler-check', version: '0.0.1', minimum_chrome_version: MIN_CHROME_VERSION,
    background: { service_worker: 'bg.js' }, permissions: ['declarativeNetRequest'], host_permissions: ['<all_urls>'],
    declarative_net_request: { rule_resources: rulesets.map((r) => ({ id: r.id, enabled: true, path: `rules/${r.id}.json` })) },
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(dir, 'bg.js'), '// compiler check\n');
}

/**
 * Loads an unpacked extension with `rulesets` (all enabled) and runs `fn` in its worker. Throws when
 * the extension does not start, which is what one invalid static rule does (S-18).
 */
export async function withRulesetExtension<T>(rulesets: readonly RulesetFile[], fn: (worker: Worker) => Promise<T>): Promise<T> {
  await mkdir(WORK_DIR, { recursive: true });
  const dirs: string[] = [];
  try {
    const ext = await mkdtemp(path.join(WORK_DIR, 'ext-'));
    dirs.push(ext);
    dirs.push(await mkdtemp(path.join(WORK_DIR, PROFILE_PREFIX)));
    await writeExtension(ext, rulesets);
    return await inBrowser(ext, dirs[1] ?? '', fn);
  } finally {
    // Cleanup never masks the result; a directory left behind is reported (`force` already ignores ENOENT).
    const removed = await Promise.allSettled(dirs.map((d) => rm(d, { recursive: true, force: true })));
    for (const r of removed) if (r.status === 'rejected') process.stderr.write(`chromium: temporary directory not removed: ${String(r.reason)}\n`);
  }
}

async function inBrowser<T>(ext: string, profile: string, fn: (worker: Worker) => Promise<T>): Promise<T> {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: WORKER_TIMEOUT_MS })
      .catch((e: unknown) => { throw new Error('the extension did not start: Chromium refused to load its rulesets', { cause: e }); });
    return await withTimeout(fn(worker), EVALUATE_TIMEOUT_MS);
  } finally {
    await context.close().catch(() => undefined); // never mask the error that got us here
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(`Chromium call timed out after ${String(ms)} ms`)); }, ms); });
  return Promise.race([p, timeout]).finally(() => { clearTimeout(timer); });
}

interface DnrApi {
  readonly isRegexSupported: (o: RegexQuery) => Promise<RegexAnswer>;
  readonly getEnabledRulesets: () => Promise<string[]>;
  readonly getAvailableStaticRuleCount: () => Promise<number>;
}
interface Global { readonly chrome: { readonly declarativeNetRequest: DnrApi } }

/** `isRegexSupported` in one launch for all queries. The callbacks run inside the extension's worker. */
export function chromiumRegexChecker(): RegexChecker {
  return {
    id: chromiumId(),
    check: (queries) => withRulesetExtension([], (worker) =>
      worker.evaluate(async (qs) => {
        const d = (globalThis as unknown as Global).chrome.declarativeNetRequest;
        const answers = await Promise.all(qs.map((q) => d.isRegexSupported(q)));
        return answers.map((r) => (r.isSupported ? { isSupported: true } : { isSupported: false, reason: r.reason ?? 'unsupported' }));
      }, queries)),
  };
}

export interface LoadResult {
  readonly enabled: readonly string[];
  /** `getAvailableStaticRuleCount()` with every ruleset enabled. */
  readonly available: number;
}

/** Loads `rulesets` unpacked, all enabled; returns what Chromium enabled and the rule count left. */
export function loadRulesets(rulesets: readonly RulesetFile[]): Promise<LoadResult> {
  return withRulesetExtension(rulesets, (worker) => worker.evaluate(async () => {
    const d = (globalThis as unknown as Global).chrome.declarativeNetRequest;
    return { enabled: (await d.getEnabledRulesets()).sort(), available: await d.getAvailableStaticRuleCount() };
  }));
}
