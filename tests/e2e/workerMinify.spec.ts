/**
 * D-75 (P3-14): terser touches the service worker only. A reference build without the hook must give every
 * other packaged file byte for byte; only `background.js` may differ. `_metadata/` (written by Chromium when
 * another spec loads the build) is not ours and is left out.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { BUILD_DIR, TEMP_PREFIX } from './helpers/fixtureExtension.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BUILD_TIMEOUT_MS = 180_000;

/** The shipped config without the D-75 hook, building into `outDir`. Test only; written to a temp folder. */
const referenceConfig = (outDir: string): string => [
  `import base from ${JSON.stringify(path.join(ROOT, 'wxt.config.ts'))};`,
  `const hooks = Object.fromEntries(Object.entries(base.hooks ?? {}).filter(([name]) => name !== 'vite:build:extendConfig'));`,
  `export default { ...base, root: ${JSON.stringify(ROOT)}, outDir: ${JSON.stringify(outDir)}, hooks };`,
].join('\n');

async function fileHashes(dir: string): Promise<ReadonlyMap<string, string>> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .filter((f) => !f.startsWith(`_metadata${path.sep}`));
  const hashed = await Promise.all(files.map(async (f) => [f, createHash('sha256').update(await readFile(path.join(dir, f))).digest('hex')] as const));
  return new Map(hashed);
}

test('the worker-only terser step changes background.js and no other packaged file', async () => {
  test.setTimeout(BUILD_TIMEOUT_MS + 30_000);
  const out = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  try {
    const config = path.join(out, 'wxt.reference.config.ts');
    await writeFile(config, referenceConfig(path.join(out, 'build')));
    await promisify(execFile)('npx', ['wxt', 'build', '-c', config], { cwd: ROOT, timeout: BUILD_TIMEOUT_MS });
    const [shipped, reference] = await Promise.all([fileHashes(BUILD_DIR), fileHashes(path.join(out, 'build', 'chrome-mv3'))]);
    expect([...shipped.keys()].sort()).toEqual([...reference.keys()].sort());
    const differing = [...shipped].filter(([f, h]) => reference.get(f) !== h).map(([f]) => f);
    expect(differing).toEqual(['background.js']);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
