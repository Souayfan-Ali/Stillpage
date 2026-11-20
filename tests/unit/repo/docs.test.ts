/**
 * The user- and reviewer-facing documents (P2-49) say only what the code does. Each check ties a
 * claim to its source: the manifest builder, the in-product privacy strings, the brand constant, the
 * network boundary. A failing check means the code changed and the document must follow (or the
 * reverse); never loosen a check to make a document pass.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { PRODUCT_NAME } from '../../../src/core/brand.js';
import { MIN_CHROME_VERSION } from '../../../src/core/limits.js';
import { createManifest } from '../../../src/core/manifest.js';
import { ISSUE_TRACKER_URL } from '../../../src/core/tracker.js';
import { PRIVACY_STRINGS } from '../../../src/features/dashboard/privacy/strings.js';
import { DRAFT_MARK, UNBACKED_CLAIMS } from './docClaims.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

/** The P2-49 document set. */
const DOCS = [
  'docs/privacy-policy.md',
  'docs/pledge.md',
  'docs/permissions.md',
  'docs/limits.md',
  'docs/reviewer-note.md',
  'docs/runbooks.md',
  'docs/release-checklist.md',
] as const;
/** Documents with legal weight: each opens with the draft mark (Q-09, Q-03). */
const LEGAL = ['docs/pledge.md', 'docs/permissions.md'] as const;
/** Published with the store listing: final text, no draft mark, no maintainer placeholders. */
const PUBLISHED = ['docs/privacy-policy.md'] as const;
/** Documents a user or reviewer reads: each names the product and no longer calls it a working name. */
const NAMED = ['docs/pledge.md', 'docs/limits.md', 'docs/reviewer-note.md'] as const;
const HEAD_LINES = 6;


/** Repository paths written in backticks, e.g. `src/core/brand.ts` (globs and placeholders skipped). */
function repoPaths(text: string): readonly string[] {
  const found = [...text.matchAll(/`((?:src|tests|compiler|docs|lists|scripts|store|plan|bench)\/[^`\s]+)`/g)].map((m) => m[1] ?? '');
  return found.filter((p) => !/[*<>{}]/.test(p)).map((p) => p.replace(/[#:].*$/, ''));
}

/** Rows `| \`name\` | …` of the Markdown table under `heading` (up to the next heading). */
function tableNames(text: string, heading: string): readonly string[] {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return [];
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(/\n#{1,6} /);
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1] ?? '');
}

/** The numbered items of a Markdown list under `heading`. */
function numberedItems(text: string, heading: string): readonly string[] {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return [];
  const rest = text.slice(start);
  return [...rest.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1] ?? '').slice(0, PRIVACY_STRINGS.pledge.length);
}

function srcFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(ROOT, rel)).isDirectory() ? srcFiles(rel) : /\.tsx?$/.test(name) ? [rel] : [];
  });
}

const manifest = createManifest();
const declared = [...manifest.permissions, ...manifest.host_permissions];

describe('the document set (P2-49)', () => {
  test.each(DOCS)('%s exists and names only repository paths that exist', (doc) => {
    expect(existsSync(path.join(ROOT, doc))).toBe(true);
    expect(repoPaths(read(doc)).filter((p) => !existsSync(path.join(ROOT, p)))).toEqual([]);
  });

  test.each(LEGAL)('%s opens with the draft mark', (doc) => {
    expect(read(doc).split('\n').slice(0, HEAD_LINES).join('\n')).toContain(DRAFT_MARK);
  });

  test.each(PUBLISHED)('%s is final: no draft mark and no owner placeholder', (doc) => {
    const text = read(doc);
    expect(text).not.toMatch(/draft/i);
    expect(text).not.toMatch(/\*owner\b|owner item/i);
    expect(text).toContain(PRODUCT_NAME);
  });

  test.each(NAMED)('%s uses the product name, which is final', (doc) => {
    const text = read(doc);
    expect(text).toContain(PRODUCT_NAME);
    expect(text).not.toMatch(/working name/i);
  });

  test.each(DOCS)('%s makes no unbacked speed, memory or completeness claim', (doc) => {
    expect(read(doc)).not.toMatch(UNBACKED_CLAIMS);
  });
});

describe('claims match the code', () => {
  test('the pledge document is the in-product pledge, word for word', () => {
    expect(numberedItems(read('docs/pledge.md'), '## The pledge (v0, draft)')).toEqual([...PRIVACY_STRINGS.pledge]);
  });

  test('the store justifications cover exactly the declared permissions', () => {
    const rows = tableNames(read('docs/permissions.md'), '## Store justification text');
    expect([...rows].sort()).toEqual([...declared].sort());
  });

  test('the privacy policy names every declared permission', () => {
    const text = read('docs/privacy-policy.md');
    expect(declared.filter((p) => !text.includes(`\`${p}\``))).toEqual([]);
  });

  test('the reviewer note names every web-accessible resource and the minimum Chrome version', () => {
    const text = read('docs/reviewer-note.md');
    const resources = manifest.web_accessible_resources.flatMap((w) => w.resources);
    expect(resources.filter((r) => !text.includes(`\`${r}\``))).toEqual([]);
    expect(text).toContain(`Chrome ${MIN_CHROME_VERSION}`);
  });

  test('"no network requests" stands: no request API in src, and the documents cite the tests that check it', () => {
    const offending = srcFiles('src').filter((f) => /\b(XMLHttpRequest|WebSocket|sendBeacon|EventSource|RTCPeerConnection)\b/.test(read(f)));
    expect(offending).toEqual([]);
    for (const doc of ['docs/privacy-policy.md', 'docs/reviewer-note.md']) {
      expect(read(doc)).toContain('`tests/e2e/noNetwork.spec.ts`');
      expect(read(doc)).toContain('`tests/unit/platform/boundaries.test.ts`');
    }
  });

  test('the privacy policy names the issue tracker the report opens, and no longer says it only copies (D-101)', () => {
    const text = read('docs/privacy-policy.md');
    expect(text).toContain(ISSUE_TRACKER_URL);
    expect(text).not.toContain('only copies the report');
  });

  test('the limits page covers the Phase 0 known differences and the late DNR change', () => {
    const headings = [...read('docs/limits.md').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(expect.arrayContaining([
      'Blocked malware pages have no "proceed" button',
      'Opening an ad or tracker address directly is not blocked',
      'A short gap after each update',
      'Without access to all sites, blocking only',
      'Right after you switch a site Off, one more load may be filtered',
    ]));
  });
});

describe('helpers', () => {
  test('repoPaths skips globs and placeholders and strips anchors', () => {
    expect(repoPaths('`src/a.ts` `src/*.ts` `docs/<x>.md` `docs/b.md#c` `other/x`')).toEqual(['src/a.ts', 'docs/b.md']);
  });

  test('the claims pattern bites', () => {
    expect('Uses less memory than others').toMatch(UNBACKED_CLAIMS);
    expect('Blocks ads and trackers').not.toMatch(UNBACKED_CLAIMS);
  });
});
