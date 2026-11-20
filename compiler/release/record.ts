/**
 * Release record (update-strategy notes §3.3 E1, tooling notes §7): what was published, so the next ruleset release can prove
 * its base is that exact zip. One SHA-256 for the zip and one per unpacked file (the store re-signs the
 * package, so later comparisons use unpacked contents, tooling notes §8).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { manifestOf } from './manifest.js';
import { readZip } from './zip.js';

const RECORD_SCHEMA = 1;
const SHA256 = /^[0-9a-f]{64}$/;

export const ReleaseRecordSchema = z.strictObject({
  schema: z.literal(RECORD_SCHEMA),
  version: z.string().min(1),
  zipSha256: z.string().regex(SHA256),
  files: z.record(z.string().min(1), z.string().regex(SHA256)),
});
export type ReleaseRecord = z.infer<typeof ReleaseRecordSchema>;

/** Lower-case hex SHA-256 of `bytes`. */
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The record of `zip` (its version read from the manifest inside). */
export function recordOf(zip: Uint8Array): ReleaseRecord {
  const entries = readZip(zip);
  return {
    schema: RECORD_SCHEMA,
    version: manifestOf(entries).version,
    zipSha256: sha256Hex(zip),
    files: Object.fromEntries(entries.map((e) => [e.path, sha256Hex(e.data)])),
  };
}
