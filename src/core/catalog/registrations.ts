/**
 * Content-script registration templates in the catalog (added by P1-06). The emitters (P1-27,
 * P1-29, P1-35) write one template per shard registration; `computeDesired` turns templates into
 * registrations by applying the user's levels. Hosts and files change only in full releases.
 */
import * as v from 'valibot';
import { isCanonicalHostname } from '../hostname/validate.js';
import type { Hostname } from '../ids.js';
import { MAX_ID_LENGTH } from '../limits.js';

export type ScriptWorld = 'ISOLATED' | 'MAIN';

/** One shard registration as packaged: which files run in which world on which filter hosts. */
export interface CatalogRegistration {
  /** Registration id (`iso:<pack>:<shard>`, `main:<pack>:<shard>`); unique in the catalog. */
  readonly id: string;
  readonly world: ScriptWorld;
  /** Packaged script paths, in injection order. */
  readonly js: readonly string[];
  /** Filter hosts; each becomes one `*://*.host/*` pattern (one pattern per host per world). */
  readonly hosts: readonly Hostname[];
}

/** Chrome rejects ids starting with `_`; ours are lower-case words, digits, `:` and `-`. */
export const REGISTRATION_ID = /^[a-z0-9][a-z0-9:-]*$/;
/** Relative packaged path to a `.js` file; no `..`, no leading `/`. */
const SCRIPT_PATH = /^(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.js$/;

export const RegistrationSchema = v.strictObject({
  id: v.pipe(v.string(), v.maxLength(MAX_ID_LENGTH * 2), v.regex(REGISTRATION_ID)),
  world: v.picklist(['ISOLATED', 'MAIN']),
  js: v.pipe(
    v.array(v.pipe(v.string(), v.regex(SCRIPT_PATH), v.check((path) => !path.includes('..'), 'path has ..'))),
    v.minLength(1),
  ),
  hosts: v.pipe(v.array(v.string()), v.minLength(1)),
});

type RawRegistration = v.InferOutput<typeof RegistrationSchema>;

/** Cross-checks the schema cannot express: canonical, unique hosts and catalog-unique ids. */
export function registrationErrors(pack: string, registrations: readonly RawRegistration[], seenIds: ReadonlySet<string>): string[] {
  const ids = new Set<string>();
  return registrations.flatMap((registration) => {
    const where = `pack "${pack}" registration "${registration.id}"`;
    const duplicateId = seenIds.has(registration.id) || ids.has(registration.id) ? [`${where}: duplicate id`] : [];
    ids.add(registration.id);
    // Sets, not indexOf: the full set is ≈ 36,000 hosts and is checked on every worker wake (P1-35).
    const seen = new Set<string>();
    const badHosts = registration.hosts.filter((host) => {
      const bad = seen.has(host) || !isCanonicalHostname(host);
      seen.add(host);
      return bad;
    }).map((host) => `${where}: invalid or repeated host "${host}"`);
    return [...duplicateId, ...badHosts];
  });
}

/**
 * The host lists live in their own packaged file (D-26), named by the catalog with its SHA-256 so the
 * two always come from one build; `catalog.json` itself stays small.
 */
export const REGISTRATIONS_FILE = 'registrations.json';

const isRecord = (x: unknown): x is Readonly<Record<string, unknown>> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Returns the raw catalog with each pack's `registrations` taken from `file` (validated afterwards by
 * `readCatalog`), or `null` when `file` is not a registrations file or names a pack the catalog lacks.
 */
export function mergeRegistrations(catalog: unknown, file: unknown): unknown {
  if (!isRecord(catalog) || !isRecord(catalog['packs']) || !isRecord(file) || file['schema'] !== 1 || !isRecord(file['packs'])) return null;
  const packs = catalog['packs'];
  const extra = file['packs'];
  if (Object.keys(extra).some((id) => !Object.hasOwn(packs, id))) return null;
  const merged = Object.fromEntries(Object.entries(packs).map(([id, pack]) =>
    [id, isRecord(pack) && Object.hasOwn(extra, id) ? { ...pack, registrations: extra[id] } : pack]));
  // P2-25: the `$generichide` hosts travel in this file too; validated with the catalog by `readCatalog`.
  return { ...catalog, packs: merged, ...(Object.hasOwn(file, 'genericOff') && { genericOff: file['genericOff'] }) };
}
