/**
 * The built extension plus fixture data (P1-14). Until the compiler emits real rulesets and a
 * catalog (P1-26), the E2E copies `.output/chrome-mv3` into a temp dir and adds: two rulesets
 * (`ubo` safe, `ubo-x` with a redirect, off in the manifest as the build gate requires), a catalog
 * with one shard registration on 127.0.0.1, its content script, a surrogate, and an extension page
 * that sends a command. Nothing of this ships.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const BUILD_DIR = path.resolve(import.meta.dirname, '../../../.output/chrome-mv3');
export const TEMP_PREFIX = 'glassmere-e2e-';

const AD_RULE_CONDITION = { urlFilter: '/ad.js', resourceTypes: ['script'] };

const RULESETS = {
  ubo: [{ id: 1, priority: 10, action: { type: 'block' }, condition: AD_RULE_CONDITION }],
  'ubo-x': [
    { id: 1, priority: 11, action: { type: 'redirect', redirect: { extensionPath: '/surrogates/noop.js' } }, condition: AD_RULE_CONDITION },
  ],
};

/** `scale`: extra shard registrations of `hostsEach` synthetic hosts, for the budget run (performance notes §2.2). */
export interface FixtureOptions {
  readonly scale?: { readonly registrations: number; readonly hostsEach: number };
  /**
   * Keep the build's own manifest, rulesets and `catalog.json` (the real registration set, P1-35) and
   * add only the command page; for the full-scale budget runs.
   */
  readonly real?: boolean;
}

function scaleRegistrations(options: FixtureOptions): readonly object[] {
  const { registrations = 0, hostsEach = 0 } = options.scale ?? {};
  // One shard in three is MAIN (scriptlets): ≈ 12,000 of 36,000 patterns, the default lists' share
  // (12,626 MAIN-scriptlet hosts of 34,980 patterns, P0-27), so the scriptlet milestone is realistic.
  const isMain = (r: number): boolean => r % 3 === 1;
  return Array.from({ length: registrations }, (_, r) => ({
    id: `${isMain(r) ? 'main' : 'iso'}:scale:${String(r)}`,
    world: isMain(r) ? 'MAIN' : 'ISOLATED',
    js: ['cs/probe.js'],
    hosts: Array.from({ length: hostsEach }, (_, h) => `h${String(h)}-r${String(r)}.example`),
  }));
}

const CATALOG = {
  schema: 1,
  rulesets: {
    ubo: { needsHostAccess: false, maxRules: 10, maxRegex: 0 },
    'ubo-x': { needsHostAccess: true, maxRules: 10, maxRegex: 0 },
  },
  packs: {
    ads: {
      rulesets: ['ubo', 'ubo-x'],
      default: true,
      licence: 'cleared',
      registrations: [{ id: 'iso:ads:1', world: 'ISOLATED', js: ['cs/probe.js'], hosts: ['127.0.0.1'] }],
    },
  },
};

/** Marks the page and tries a command from a content-script context (must be refused). */
const PROBE = `document.documentElement.dataset.probe = 'ran';
chrome.runtime.sendMessage({ v: 1, type: 'c/reconcile', id: 'cs1', payload: {} }).then(
  (r) => { document.documentElement.dataset.command = r && r.ok ? 'accepted' : (r && r.error && r.error.code) || 'none'; },
  () => { document.documentElement.dataset.command = 'error'; });
`;
const SURROGATE = 'window.adSurrogate = true;\n';
const COMMAND_PAGE = '<!doctype html><meta charset="utf-8"><title>e2e</title><script src="e2e.js"></script>';
const COMMAND_SCRIPT = `chrome.runtime.sendMessage({ v: 1, type: 'c/reconcile', id: 'p1', payload: {} }).then((r) => {
  document.title = JSON.stringify(r);
});
`;

export interface FixtureExtension {
  readonly dir: string;
  /** Rewrites the manifest version (an in-place update needs a new version). */
  readonly setVersion: (version: string) => Promise<void>;
  readonly remove: () => Promise<void>;
}

async function writeFiles(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
}

export async function createFixtureExtension(options: FixtureOptions = {}): Promise<FixtureExtension> {
  const root = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  const dir = path.join(root, 'ext');
  await cp(BUILD_DIR, dir, { recursive: true });
  if (options.real === true) {
    await writeFiles(dir, { 'e2e.html': COMMAND_PAGE, 'e2e.js': COMMAND_SCRIPT });
    return handle(root, dir);
  }
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const withData = {
    ...manifest,
    declarative_net_request: {
      rule_resources: [
        { id: 'ubo', enabled: true, path: 'rulesets/ubo.json' },
        { id: 'ubo-x', enabled: false, path: 'rulesets/ubo-x.json' },
      ],
    },
    web_accessible_resources: [{ resources: ['surrogates/*'], matches: ['<all_urls>'], use_dynamic_url: true }],
  };
  await writeFiles(dir, {
    'manifest.json': JSON.stringify(withData),
    'rulesets/ubo.json': JSON.stringify(RULESETS.ubo),
    'rulesets/ubo-x.json': JSON.stringify(RULESETS['ubo-x']),
    'catalog.json': JSON.stringify({
      ...CATALOG,
      packs: { ...CATALOG.packs, scale: { rulesets: [], default: true, licence: 'cleared', registrations: scaleRegistrations(options) } },
    }),
    'cs/probe.js': PROBE,
    'surrogates/noop.js': SURROGATE,
    'e2e.html': COMMAND_PAGE,
    'e2e.js': COMMAND_SCRIPT,
  });
  return handle(root, dir);
}

function handle(root: string, dir: string): FixtureExtension {
  return {
    dir,
    setVersion: async (version) => {
      const current = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ ...current, version }));
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
