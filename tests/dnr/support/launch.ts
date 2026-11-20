/**
 * Several unpacked test extensions in **one** bundled-Chromium launch (testing notes §5: thousands of
 * `testMatchOutcome` rows cost one launch). Each extension gets its own rulesets and either
 * `<all_urls>` or no host access (Chrome applies host-access rules in `testMatchOutcome` too,
 * P1-44). Extension and profile dirs live under `.cache/compiler/` with the compiler port's prefixes,
 * so `expectNoSurvivors` covers them; everything is removed and closed in `finally`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { PROFILE_PREFIX } from '../../../compiler/chromium/node-ports.js';
import { MIN_CHROME_VERSION } from '../../../src/core/limits.js';

const WORK_DIR = path.resolve(import.meta.dirname, '../../../.cache/compiler');
const WORKER_TIMEOUT_MS = 20_000;

export interface TestRuleset {
  readonly id: string;
  readonly rules: readonly object[];
  /** Declared `enabled` in the manifest (default true). */
  readonly enabled?: boolean;
}

export interface ExtensionSpec {
  /** Unique name; the worker answers it, so each worker can be found. */
  readonly name: string;
  readonly rulesets: readonly TestRuleset[];
  readonly hostAccess: boolean;
}

async function writeExtension(dir: string, spec: ExtensionSpec): Promise<void> {
  await mkdir(path.join(dir, 'rules'), { recursive: true });
  for (const r of spec.rulesets) await writeFile(path.join(dir, 'rules', `${r.id}.json`), JSON.stringify(r.rules));
  const manifest = {
    manifest_version: 3,
    name: `dnr-${spec.name}`,
    version: '0.0.1',
    minimum_chrome_version: MIN_CHROME_VERSION,
    background: { service_worker: 'bg.js' },
    permissions: ['declarativeNetRequest'],
    ...(spec.hostAccess ? { host_permissions: ['<all_urls>'] } : {}),
    declarative_net_request: {
      rule_resources: spec.rulesets.map((r) => ({ id: r.id, enabled: r.enabled ?? true, path: `rules/${r.id}.json` })),
    },
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(dir, 'bg.js'), `self.TEST_NAME = ${JSON.stringify(spec.name)};\n`);
}

/** An extension directory that already exists (uBOL's release, P1-45), named for the caller. */
export interface PrebuiltExtension {
  readonly name: string;
  readonly dir: string;
}

async function workersByName(context: BrowserContext, count: number, prebuilt: PrebuiltExtension | undefined): Promise<ReadonlyMap<string, Worker>> {
  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  while (context.serviceWorkers().length < count) {
    if (Date.now() > deadline) throw new Error('an extension did not start: Chromium refused its rulesets');
    await context.waitForEvent('serviceworker', { timeout: Math.max(1, deadline - Date.now()) }).catch(() => undefined);
  }
  const named = await Promise.all(
    context.serviceWorkers().map(async (w) => {
      const name = await w.evaluate(() => (self as unknown as { TEST_NAME?: string }).TEST_NAME);
      return [name ?? prebuilt?.name ?? 'unknown', w] as const;
    }),
  );
  return new Map(named);
}

/**
 * Loads every spec (and an optional prebuilt extension) unpacked in one browser and runs `fn` with
 * each extension's worker by name.
 */
export async function withExtensions<T>(
  specs: readonly ExtensionSpec[],
  fn: (workers: ReadonlyMap<string, Worker>) => Promise<T>,
  prebuilt?: PrebuiltExtension,
): Promise<T> {
  await mkdir(WORK_DIR, { recursive: true });
  const dirs: string[] = [];
  try {
    const exts = await Promise.all(specs.map(async (spec) => {
      const dir = await mkdtemp(path.join(WORK_DIR, 'ext-'));
      dirs.push(dir);
      await writeExtension(dir, spec);
      return dir;
    }));
    const profile = await mkdtemp(path.join(WORK_DIR, PROFILE_PREFIX));
    dirs.push(profile);
    const list = [...exts, ...(prebuilt === undefined ? [] : [prebuilt.dir])].join(',');
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${list}`, `--load-extension=${list}`],
    });
    try {
      return await fn(await workersByName(context, specs.length + (prebuilt === undefined ? 0 : 1), prebuilt));
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    await Promise.allSettled(dirs.map((d) => rm(d, { recursive: true, force: true })));
  }
}
