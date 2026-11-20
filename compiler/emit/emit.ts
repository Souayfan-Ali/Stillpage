/**
 * Stage 8 (filter-pipeline notes §2, P1-26): everything the build writes, as `path → text`, deterministic for equal
 * inputs (sorted, no timestamps). `shipped` goes to `public/` (packaged by WXT); `debug` goes to
 * `dist/compiler/` and is never packaged (id maps are a release asset, the log and the manifest
 * fragment are build reports).
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { ListsConfig } from '../config/schema.js';
import type { Entities } from '../entities/schema.js';
import type { LogEntry } from '../normalise/normalise.js';
import { assertKnownKeys, countSlot, type Slot, type SlotCount } from '../postpass/budgets.js';
import type { BucketedRule } from '../postpass/coalesce.js';
import { MAX_BUCKETS_GZIP_BYTES } from '../../src/core/limits.js';
import { bucketsOf } from './buckets.js';
import { PROCEDURAL_ENGINE } from '../../src/core/content/files.js';
import { REGISTRATIONS_FILE } from '../../src/core/catalog/registrations.js';
import type { ContentBuild } from '../content/build.js';
import { surrogateFiles, surrogatesUsed } from '../surrogates/files.js';
import { catalogOf } from './catalog.js';

export interface EmitInput {
  readonly config: ListsConfig;
  readonly slots: readonly Slot[];
  /** Slot id → rules with ledger ids (missing = empty slot). */
  readonly rules: ReadonlyMap<string, readonly BucketedRule[]>;
  readonly entities: Entities;
  readonly destinations: readonly string[];
  /** `popup-lifted.json` (D-55a): justifying ruleset id → lifted destinations. */
  readonly lifted: Readonly<Record<string, readonly string[]>>;
  readonly strictSites: readonly string[];
  readonly log: readonly LogEntry[];
  /** Content data files and registrations (P1-27…P1-29) and uBO's procedural engine text (P1-28). */
  readonly content?: { readonly build: ContentBuild; readonly engine: string };
  /** uBO resource file → bytes; the ones the `-x` rules redirect to ship under `surrogates/` (P1-30). */
  readonly surrogates?: ReadonlyMap<string, Uint8Array>;
}

export interface EmitOutput {
  readonly shipped: ReadonlyMap<string, string>;
  readonly debug: ReadonlyMap<string, string>;
  /** Binary packaged files (surrogates), path → bytes. */
  readonly binary: ReadonlyMap<string, Uint8Array>;
  readonly counts: ReadonlyMap<string, SlotCount>;
}

/** Path of a slot's ruleset file inside the package (`rule_resources[].path`). */
export const rulesetPath = (slot: string): string => `rulesets/${slot}.json`;
const json = (value: unknown): string => JSON.stringify(value);
const pretty = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

const sortedLog = (log: readonly LogEntry[]): readonly LogEntry[] => [...log].sort((a, b) =>
  a.source.list < b.source.list ? -1 : a.source.list > b.source.list ? 1 : a.source.line - b.source.line || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

/** `rule_resources` for the manifest: default safe slots on, every `-x` and every other slot off (D-06). */
export function manifestFragment(slots: readonly Slot[]): unknown {
  return { declarative_net_request: { rule_resources: slots.map((s) => ({ id: s.id, enabled: s.isDefault && !s.unsafe, path: rulesetPath(s.id) })) } };
}

function idmapOf(rules: readonly BucketedRule[]): unknown {
  return Object.fromEntries(rules.map((r) => [String(r.rule.id), r.sources.map((s) => ({ list: s.source.list, line: s.source.line, text: s.source.text }))]));
}

/** Data files plus the engine when some registration lists it (sorted by path). */
function contentFiles(content: EmitInput['content']): readonly (readonly [string, string])[] {
  if (content === undefined) return [];
  const usesEngine = [...content.build.registrations.values()].flat().some((r) => r.js.includes(PROCEDURAL_ENGINE));
  const files = [...content.build.files, ...(usesEngine ? [[PROCEDURAL_ENGINE, content.engine] as const] : [])];
  return [...files].sort(([a], [b]) => (a < b ? -1 : 1));
}

/** All output files. Throws when an emitted rule has an unknown key or `buckets.json` is over budget. */
export function emitBuild(input: EmitInput): EmitOutput {
  const shipped = new Map<string, string>();
  const debug = new Map<string, string>();
  const counts = new Map<string, SlotCount>();
  for (const s of input.slots) {
    const rules = [...(input.rules.get(s.id) ?? [])].sort((a, b) => a.rule.id - b.rule.id);
    const dnr = rules.map((r) => r.rule);
    assertKnownKeys(s.id, dnr);
    const text = json(dnr);
    shipped.set(rulesetPath(s.id), text);
    counts.set(s.id, countSlot(dnr, text));
    if (rules.length > 0) debug.set(`debug/idmap/${s.id}.json`, pretty(idmapOf(rules)));
  }
  const buckets = json(bucketsOf(new Map(input.slots.map((s) => [s.id, input.rules.get(s.id) ?? []])), input.entities));
  const gz = gzipSync(buckets, { level: 9 }).length;
  if (gz > MAX_BUCKETS_GZIP_BYTES) throw new Error(`buckets.json is ${String(gz)} B gzip (budget ${String(MAX_BUCKETS_GZIP_BYTES)})`);
  shipped.set('buckets.json', buckets);
  for (const [p, text] of contentFiles(input.content)) shipped.set(p, text);
  const registrations = input.config.content.catalogRegistrations ? input.content?.build.registrations : undefined;
  // D-26: host lists ship in their own file, named by the catalog with its SHA-256.
  // P2-25: the `$generichide` hosts ride in the same SHA-checked file (design review: host lists live there, D-26).
  const genericOff = [...new Set(input.content?.build.generic.off ?? [])].sort();
  const regsText = registrations === undefined ? undefined : json({ schema: 1, packs: Object.fromEntries([...registrations].filter(([, r]) => r.length > 0)), genericOff });
  if (regsText !== undefined) shipped.set(REGISTRATIONS_FILE, regsText);
  const ref = regsText === undefined ? undefined : { path: REGISTRATIONS_FILE, sha256: createHash('sha256').update(regsText).digest('hex') };
  shipped.set('catalog.json', json(catalogOf(input.config, input.slots, ref, new Set(Object.keys(input.content?.build.generic.packs ?? {})))));
  if (input.content) debug.set('registrations.json', pretty(Object.fromEntries(input.content.build.registrations)));
  shipped.set('popup-destinations.json', json(input.destinations));
  shipped.set('popup-strict-sites.json', json(input.strictSites));
  shipped.set('popup-lifted.json', json(input.lifted));
  debug.set('log.json', pretty(sortedLog(input.log).map((l) => ({ ...l.source, reason: l.reason, ...(l.detail !== undefined && { detail: l.detail }) }))));
  debug.set('manifest.dnr.json', pretty(manifestFragment(input.slots)));
  const unsafe = input.slots.filter((s) => s.unsafe).flatMap((s) => (input.rules.get(s.id) ?? []).map((r) => r.rule));
  const binary = input.surrogates === undefined ? new Map<string, Uint8Array>() : surrogateFiles(surrogatesUsed(unsafe), input.surrogates);
  return { shipped, debug, binary, counts };
}
