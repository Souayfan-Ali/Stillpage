/** Shared by the P2-47 diagnosis scripts: building a variant directory and waiting for the install reconcile. */
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Worker } from '@playwright/test';
import { applyVariant, type Variant } from './variants.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BUILD_DIR = path.join(ROOT, '.output/chrome-mv3');
const UBOL_DIR = path.join(ROOT, '.cache/spikes/ubol/unpacked');
const TEXT_FILES = ['manifest.json', 'catalog.json', 'registrations.json', 'background.js'];
const RECONCILE_TIMEOUT_MS = 60_000;

export type Config = Variant | 'none' | 'ubol';

export async function variantDir(config: Config, root: string): Promise<string | null> {
  if (config === 'none') return null;
  if (config === 'ubol') return UBOL_DIR;
  const dir = path.join(root, config);
  await cp(BUILD_DIR, dir, { recursive: true });
  const files = new Map(await Promise.all(TEXT_FILES.map(async (f) => [f, await readFile(path.join(dir, f), 'utf8')] as const)));
  for (const [f, text] of applyVariant(files, config)) await writeFile(path.join(dir, f), text);
  return dir;
}

export async function reconciled(worker: Worker): Promise<void> {
  const deadline = Date.now() + RECONCILE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const done = await worker.evaluate(async () => {
      const s = await chrome.storage.session.get(['reconcile.pending', 'reconcile.last']);
      return s['reconcile.pending'] !== true && s['reconcile.last'] !== undefined;
    });
    if (done) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('install reconcile did not finish');
}
