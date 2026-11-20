/**
 * The draft store listing (P2-50, store notes §3): copy within the store's limits and the plan's claim rules,
 * no other company's names, assets at the store's sizes. The assets are made by
 * `tests/e2e/store/storeAssets.spec.ts` from the real build on local fixtures.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { STORE_NAME } from '../../../src/core/brand.js';
import { DRAFT_MARK, pngSize, UNBACKED_CLAIMS } from './docClaims.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const STORE = path.join(ROOT, 'store');
const listing = (): string => readFileSync(path.join(STORE, 'listing.md'), 'utf8');

/** The store's summary limit (store notes §3). */
const SUMMARY_MAX = 132;
/** The store's screenshot size and the most we submit (store notes §3; the cap is re-checked at submission). */
const SCREENSHOT = { width: 1280, height: 800 } as const;
const MAX_SCREENSHOTS = 5;
const PROMO_TILE = { width: 440, height: 280 } as const;
const ICON_SIZES = [16, 32, 48, 128] as const;

/** Names of other companies and products that the listing must not use, as keywords or comparisons (store notes §3, §6). */
const OTHER_BRANDS = /\b(ublock|ubo|adguard|adblock|ghostery|brave|eyeo|acceptable ads|youtube|facebook|twitter|duckduckgo|opera|firefox|edge)\b/i;

/** The value of a `**Field:** value` line. */
function field(text: string, name: string): string {
  const line = text.split('\n').find((l) => l.startsWith(`**${name}:** `));
  return line === undefined ? '' : line.slice(`**${name}:** `.length).trim();
}

const png = (file: string): { readonly width: number; readonly height: number } | null => pngSize(readFileSync(file));

describe('listing copy (P2-50)', () => {
  test('opens with the draft mark and names the store title', () => {
    const text = listing();
    expect(text.split('\n').slice(0, 6).join('\n')).toContain(DRAFT_MARK);
    expect(field(text, 'Name')).toBe(STORE_NAME);
    expect(text).not.toMatch(/working name/i);
  });

  test('the summary fits the store and is the manifest description to set', () => {
    const summary = field(listing(), 'Summary');
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
  });

  test('names no other company or product and makes no unbacked claim', () => {
    const text = listing();
    expect(OTHER_BRANDS.exec(text)?.[0]).toBeUndefined();
    expect(text).not.toMatch(UNBACKED_CLAIMS);
  });

  test('D-117: where the listing says "no network requests" it names the GitHub report link', () => {
    const text = listing();
    expect(text).toContain('It makes no network requests.');
    expect(text).toContain('"Open a new issue" in a problem report opens github.com in a browser tab');
  });

  test('every screenshot named in the listing exists', () => {
    const named = [...listing().matchAll(/`store\/screenshots\/([^`]+\.png)`/g)].map((m) => m[1] ?? '');
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((f) => !existsSync(path.join(STORE, 'screenshots', f)))).toEqual([]);
  });
});

describe('listing assets (P2-50)', () => {
  test.each(ICON_SIZES)('icon %i px is a square PNG of that size', (size) => {
    expect(png(path.join(STORE, 'icon', `icon-${String(size)}.png`))).toEqual({ width: size, height: size });
  });

  test('the promo tile is 440 × 280', () => {
    expect(png(path.join(STORE, 'promo-tile-440x280.png'))).toEqual(PROMO_TILE);
  });

  test('one to five screenshots, each 1280 × 800', () => {
    const shots = readdirSync(path.join(STORE, 'screenshots')).filter((f) => f.endsWith('.png'));
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.length).toBeLessThanOrEqual(MAX_SCREENSHOTS);
    expect(shots.map((f) => png(path.join(STORE, 'screenshots', f)))).toEqual(shots.map(() => SCREENSHOT));
  });

  test('pngSize reads a PNG header and refuses anything else', () => {
    const header = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 5, 0, 0, 0, 3, 32]);
    expect(pngSize(header)).toEqual({ width: 1280, height: 800 });
    expect(pngSize(new Uint8Array(24))).toBeNull();
  });
});
