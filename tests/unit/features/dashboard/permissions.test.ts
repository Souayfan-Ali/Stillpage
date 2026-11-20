import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { createManifest } from '../../../../src/core/manifest.js';
import { NOT_REQUESTED, PERMISSION_ROWS } from '../../../../src/features/dashboard/privacy/permissions.js';

const doc = readFileSync(path.resolve(import.meta.dirname, '../../../../docs/permissions.md'), 'utf8');
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('privacy page permissions table (P2-36)', () => {
  test('names exactly the permissions the manifest declares', () => {
    const manifest = createManifest();
    expect(sorted(PERMISSION_ROWS.map((r) => r.permission))).toEqual(sorted([...manifest.permissions, ...manifest.host_permissions]));
  });

  test('names exactly the declared rows of docs/permissions.md', () => {
    const declared = [...doc.matchAll(/^\| `([^`]+)` \| declared \|/gm)].map((m) => m[1] ?? '');
    expect(sorted(PERMISSION_ROWS.map((r) => r.permission))).toEqual(sorted(declared));
  });

  test('"never asked for" are never declared and are listed as never declared in the doc', () => {
    const manifest = createManifest();
    for (const row of NOT_REQUESTED) {
      expect(manifest.permissions).not.toContain(row.permission);
      expect(doc).toContain(`\`${row.permission}\``);
    }
  });

  test('every row has a name and a reason', () => {
    expect([...PERMISSION_ROWS, ...NOT_REQUESTED].every((r) => r.name.length > 0 && r.why.length > 20)).toBe(true);
  });
});
