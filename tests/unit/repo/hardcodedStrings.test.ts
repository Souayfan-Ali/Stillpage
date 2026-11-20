/**
 * P2-40 acceptance "no hardcoded strings (lint)": every user-visible string of the UI comes from
 * `_locales/<lang>/messages.json` through `chrome.i18n` (UI notes §10, tooling notes §4).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { findHardcoded, findHardcodedInHtml } from './hardcodedStrings.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');

/** Where user-visible strings are written: pages, shared UI, the picker's in-page parts, the worker's menu. */
const UI_ROOTS = ['src/features', 'src/ui', 'src/entrypoints', 'src/content/picker', 'src/content/popup-sentinel', 'src/platform'];

/**
 * Not copy. Data shown as written: third-party list titles and credits (proper names and licence names
 * from `lists/lists.config.json` and CREDITS.md).
 */
const DATA_FILES = new Set(['src/features/dashboard/packLists.ts', 'src/features/dashboard/about/credits.ts']);

/** The MAIN-world pop-up shim and strict guard: no copy, and no `chrome.i18n` in the page's world. */
const GUARD_OWNED = [/^src\/entrypoints\/popup-(shim|strict)\.ts$/];

function walk(dir: string): readonly string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(rel) : [rel];
  });
}

const uiFiles = (pattern: RegExp): readonly string[] =>
  UI_ROOTS.flatMap(walk).filter((f) => pattern.test(f) && !DATA_FILES.has(f) && !GUARD_OWNED.some((g) => g.test(f)));

const isStringModule = (file: string): boolean => /strings\.ts$/i.test(path.basename(file));

describe('the rule itself', () => {
  test('flags JSX text, visible attributes, prose and element text', () => {
    const source = [
      'const a = <p>Hello</p>;',
      'const b = <button aria-label="Close" />;',
      "const c = 'Saved. Reload the page.';",
      "el(doc, 'button', { type: 'button' }, 'Cancel');",
      "node.setAttribute('title', 'hide');",
      "const d = { label: 'Light' };",
      'const e = `Paused until ${t}`;',
    ].join('\n');
    expect(findHardcoded('x.tsx', source).map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('passes structure: specifiers, types, keys, classes, errors, logger, key names, marked lines', () => {
    const source = [
      "import { x } from './Some Module.js';",
      "type Kind = 'Light Mode';",
      "if (e.key === 'Escape') close();",
      "throw new Error('Invalid payload for this');",
      "logger.warn('Could not save the thing');",
      "const o = { 'Some Key': 1, type: 'button', class: styles['brand'] };",
      "const p = <path d=\"M4 8 L 12 4\" class=\"Primary Big\" />;",
      "const q = 'Not Copy'; // i18n-exempt: a test",
      "const r = t('panel_loading');",
    ].join('\n');
    expect(findHardcoded('x.tsx', source)).toEqual([]);
  });

  test('a strings module may hold no letter-bearing string at all', () => {
    expect(findHardcoded('strings.ts', "const onOff = (on) => (on ? 'on' : 'off');", true).length).toBe(2);
  });

  test('HTML shells: text, title and visible attributes; comments and scripts pass', () => {
    const html = '<!-- Loading text -->\n<title>Name</title>\n<p>Loading…</p>\n<div aria-label="Main"></div>\n<script>const a = "Text"</script>';
    expect(findHardcodedInHtml(html).map((f) => f.line)).toEqual([2, 3, 4]);
  });
});

describe('no hardcoded user-visible strings in the UI (P2-40)', () => {
  test('TypeScript and TSX', () => {
    const findings = uiFiles(/\.tsx?$/).flatMap((file) =>
      findHardcoded(file, readFileSync(path.join(ROOT, file), 'utf8'), isStringModule(file)).map((f) => `${file}:${String(f.line)}: ${f.text}`),
    );
    expect(findings).toEqual([]);
  });

  test('HTML shells of the extension pages', () => {
    const findings = uiFiles(/\.html$/).flatMap((file) =>
      findHardcodedInHtml(readFileSync(path.join(ROOT, file), 'utf8')).map((f) => `${file}:${String(f.line)}: ${f.text}`),
    );
    expect(findings).toEqual([]);
  });

  test('the scan covers every page and the shared UI', () => {
    const files = uiFiles(/\.(tsx?|html)$/);
    for (const page of ['popup', 'dashboard', 'onboarding', 'picker-panel']) expect(files).toContain(`src/entrypoints/${page}/index.html`);
    expect(files.filter(isStringModule).length).toBeGreaterThanOrEqual(12);
  });
});
