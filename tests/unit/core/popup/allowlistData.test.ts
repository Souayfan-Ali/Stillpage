import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { PROVIDER_ALLOWLIST } from '../../../../src/content/popup-sentinel/allowlist.js';
import { compiledText, loadAllowlist } from '../../../../src/core/popup/allowlist.js';

const root = path.resolve(import.meta.dirname, '../../../..');
const source = JSON.parse(readFileSync(path.join(root, 'lists/popup-allow.json'), 'utf8')) as { entries: unknown[] };
const destinations = (): readonly string[] => {
  try {
    return JSON.parse(readFileSync(path.join(root, 'public/popup-destinations.json'), 'utf8')) as string[];
  } catch {
    return [];
  }
};

describe('lists/popup-allow.json (pop-up notes §8)', () => {
  test('passes the admission lint against the pop-up destinations, and the sentinel carries exactly its compiled form', () => {
    const loaded = loadAllowlist(source.entries, { adHosts: new Set(destinations()), gzipBytes: (t) => gzipSync(t).length });
    expect(loaded).toMatchObject({ ok: true });
    if (!loaded.ok) return;
    expect(compiledText(PROVIDER_ALLOWLIST)).toBe(compiledText(loaded.value));
    expect(gzipSync(compiledText(loaded.value)).length).toBeLessThanOrEqual(1_024);
  });
});
