/** The parts of a packaged `manifest.json` that release tooling reads (P2-01, P2-02). */
import { z } from 'zod';
import type { ZipEntry } from './zip.js';

export const MANIFEST_PATH = 'manifest.json';
/** D-06: `-x` rulesets hold the unsafe rules and are frozen between full releases. */
export const UNSAFE_SUFFIX = '-x';

const RuleResourceSchema = z.looseObject({ id: z.string().min(1), enabled: z.boolean(), path: z.string().min(1) });

const ManifestSchema = z.looseObject({
  version: z.string().min(1),
  declarative_net_request: z.looseObject({ rule_resources: z.array(RuleResourceSchema).readonly() }).optional(),
});

export interface PackagedManifest {
  readonly version: string;
  readonly ruleResources: readonly { readonly id: string; readonly enabled: boolean; readonly path: string }[];
  readonly text: string;
  readonly json: unknown;
}

/** Zip path of a `rule_resources` path (Chrome accepts a leading `/`). */
const zipPathOf = (resourcePath: string): string => resourcePath.replace(/^\/+/, '');

/** Parses the manifest entry of a zip; throws when it is missing or malformed. */
export function manifestOf(entries: readonly ZipEntry[]): PackagedManifest {
  const entry = entries.find((e) => e.path === MANIFEST_PATH);
  if (entry === undefined) throw new Error('zip has no manifest.json');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(entry.data);
  const json: unknown = JSON.parse(text);
  const m = ManifestSchema.parse(json);
  const ruleResources = (m.declarative_net_request?.rule_resources ?? []).map((r) => ({ id: r.id, enabled: r.enabled, path: zipPathOf(r.path) }));
  return { version: m.version, ruleResources, text, json };
}

const VERSION_KEY = /("version"\s*:\s*")([^"\\]*)(")/g;

/**
 * `manifest.json` text with only the version value replaced (repack, P2-01) — and the reference the gate's
 * E4 compares candidate bytes against. Throws unless exactly one `"version"` key exists and no `version_name`.
 */
export function withVersion(manifest: PackagedManifest, version: string): string {
  if (typeof manifest.json === 'object' && manifest.json !== null && 'version_name' in manifest.json) {
    throw new Error('manifest has version_name; the scheme does not use it (update-strategy notes §7)');
  }
  const hits = [...manifest.text.matchAll(VERSION_KEY)];
  if (hits.length !== 1) throw new Error(`expected exactly one "version" key in manifest.json, found ${String(hits.length)}`);
  return manifest.text.replace(VERSION_KEY, `$1${version}$3`);
}
