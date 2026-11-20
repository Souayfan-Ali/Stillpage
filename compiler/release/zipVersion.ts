/**
 * The `version` of a packaged zip's `manifest.json`, dependency-free (D-71): the store uploader runs with plain
 * `node` in the key-holding job, so it cannot use `manifest.ts` (zod). Throws when the manifest is missing, not
 * strict UTF-8 JSON, or has no non-empty version string.
 */
import { readZip } from './zip.ts';

export function zipManifestVersion(zip: Uint8Array): string {
  const entry = readZip(zip).find((e) => e.path === 'manifest.json');
  if (entry === undefined) throw new Error('zip has no manifest.json');
  const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.data));
  const version = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>)['version'] : undefined;
  if (typeof version !== 'string' || version === '') throw new Error('manifest.json has no version string');
  return version;
}
