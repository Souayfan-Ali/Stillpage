/**
 * Reads the packaged `catalog.json` (design decision, 2026-11-14, P1-13) and, when it names one, the
 * packaged `registrations.json` with the shard registrations' host lists (D-26). These are the
 * **only** `fetch`es in shipped code, and they read our own package: each URL is a constant built
 * with `runtime.getURL`, and anything not under our own `chrome-extension://<id>/` is refused before
 * the call. Nothing leaves the device (security notes §10). The registrations file must match the SHA-256
 * the catalog names (one build); then the merged value is validated with `readCatalog`. A missing,
 * mismatched or invalid file rejects, so the reconciler fails closed to the manifest state.
 * Memoised per wake only; never copied into `storage.*` (an update restarts the worker).
 */
import { readCatalog } from '../core/catalog/read.js';
import { mergeRegistrations, REGISTRATIONS_FILE } from '../core/catalog/registrations.js';
import type { Catalog, CatalogPackSummary } from '../core/catalog/types.js';
import type { PackId } from '../core/ids.js';
import type { RuntimeApi } from './chromeApi.js';
import type { CatalogPort, PackagePort } from './ports.js';

const CATALOG_PATH = 'catalog.json';

type FetchJson = (url: string) => Promise<unknown>;

/** Reading `registrations.json` as text and hashing it (the worker's `crypto.subtle`). */
export interface PackagedFiles {
  readonly fetchText: (url: string) => Promise<string>;
  readonly sha256: (text: string) => Promise<string>;
}

/** Builds the URL of a packaged file and checks it is inside our own package. Throws otherwise. */
function ownUrl(runtime: RuntimeApi, file: string): string {
  const base = runtime.getURL('');
  const url = runtime.getURL(file);
  const isOwn = base === `chrome-extension://${runtime.id}/` && url === `${base}${file}`;
  if (!isOwn) throw new Error('catalog URL is not inside the extension package');
  return url;
}

export function ownCatalogUrl(runtime: RuntimeApi): string {
  return ownUrl(runtime, CATALOG_PATH);
}

const refOf = (raw: unknown): { readonly sha256: string } | undefined => {
  const ref = (raw as { registrations?: unknown } | null)?.registrations;
  return typeof ref === 'object' && ref !== null && typeof (ref as { sha256?: unknown }).sha256 === 'string' ? (ref as { sha256: string }) : undefined;
};

async function withRegistrations(runtime: RuntimeApi, raw: unknown, files: PackagedFiles | undefined): Promise<unknown> {
  const ref = refOf(raw);
  if (ref === undefined) return raw;
  if (files === undefined) throw new Error(`catalog names ${REGISTRATIONS_FILE} but no reader was given`);
  const text = await files.fetchText(ownUrl(runtime, REGISTRATIONS_FILE));
  if ((await files.sha256(text)) !== ref.sha256) throw new Error(`${REGISTRATIONS_FILE} does not match the catalog`);
  const merged = mergeRegistrations(raw, JSON.parse(text));
  if (merged === null) throw new Error(`invalid ${REGISTRATIONS_FILE}`);
  return merged;
}

/** Shard data paths the CSS fallback may read: `cosmetic/<pack>/<n>.js` only. */
const DATA_PATH = /^cosmetic\/[a-z][a-z0-9-]*\/\d{1,3}\.js$/;
/** The packaged pop-up host lists (P2-54) and the attribution map (P2-11), by exact name. */
const POPUP_LISTS: ReadonlySet<string> = new Set(['popup-destinations.json', 'popup-strict-sites.json', 'popup-lifted.json', 'buckets.json']);

/** Reads shard data files and the pop-up lists of our own package as text (P1-38, P2-54); any other path is refused. */
export function createPackagePort(runtime: RuntimeApi, files: PackagedFiles): PackagePort {
  return {
    readText: async (path) => {
      if (!DATA_PATH.test(path) && !POPUP_LISTS.has(path)) throw new Error('not a shard data path');
      return files.fetchText(ownUrl(runtime, path));
    },
  };
}

/** Memoises a promise for one wake; a rejection is not kept, so the next call tries again. */
function memoised<T>(load: () => Promise<T>): () => Promise<T> {
  let memo: Promise<T> | null = null;
  return () => {
    memo ??= load().catch((error: unknown) => {
      memo = null;
      throw error;
    });
    return memo;
  };
}

export function createCatalogPort(runtime: RuntimeApi, fetchJson: FetchJson, files?: PackagedFiles): CatalogPort {
  // `hosts`: merge and check `registrations.json` (D-26); without it `catalog.json` alone, validated the same way.
  const load = async (hosts: boolean): Promise<Catalog> => {
    const raw = await fetchJson(ownCatalogUrl(runtime));
    const result = readCatalog(hosts ? await withRegistrations(runtime, raw, files) : raw);
    if (!result.ok) throw new Error(`invalid catalog: ${result.errors.slice(0, 3).join('; ')}`);
    return result.value;
  };
  // D-65: the summary's type has no `registrations` (empty here: the host lists are never read).
  const readPacks = memoised(async (): Promise<Readonly<Record<PackId, CatalogPackSummary>>> => (await load(false)).packs);
  return { read: memoised(() => load(true)), readPacks };
}

/** `fetch` of a package file as JSON. Used only through `createCatalogPort`. */
export async function fetchPackagedJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`package read failed: ${String(response.status)}`);
  return response.json();
}

/** `fetch` of a package file as text, and its SHA-256 in hex. Used only through `createCatalogPort`. */
export const packagedFiles: PackagedFiles = {
  fetchText: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`package read failed: ${String(response.status)}`);
    return response.text();
  },
  sha256: async (text) => {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  },
};
