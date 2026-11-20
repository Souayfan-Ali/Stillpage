/** P1-13 build-artefact test: the manifest we ship passes the gate of `checkBuiltManifest`. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { checkBuiltManifest, ICON_FILES, readRuleResources } from '../../src/core/manifest.js';
import { withoutPendingPacks } from '../../compiler/config/channel.js';
import { loadListsConfig } from '../../compiler/config/load.js';
import { slotsOf } from '../../compiler/postpass/budgets.js';
import { forbiddenMarkers } from '../../scripts/repro/compare.js';
import { BUILD_DIR } from './helpers/fixtureExtension.js';

const sortedIds = (ids: readonly string[]): readonly string[] => [...ids].sort();

/** The slot ids of the dev build (every pack) and of the store build (`--drop-pending`, P2-29). */
async function buildSlotIds(): Promise<{ readonly full: readonly string[]; readonly store: readonly string[] }> {
  const full = await loadListsConfig(path.resolve(import.meta.dirname, '../../lists/lists.config.json'));
  return { full: sortedIds(slotsOf(full).map((s) => s.id)), store: sortedIds(slotsOf(withoutPendingPacks(full)).map((s) => s.id)) };
}

test('the built manifest has no content_scripts, every -x ruleset off and only the declared permissions', async () => {
  const manifest: unknown = JSON.parse(await readFile(path.join(BUILD_DIR, 'manifest.json'), 'utf8'));
  const declared = sortedIds(readRuleResources(manifest).map((r) => r.id));
  const { full, store } = await buildSlotIds();
  // Either every slot (dev build) or exactly the store build's: only the owner-pending packs' slots missing.
  expect([full, store]).toContainEqual(declared);
  expect(checkBuiltManifest(manifest, declared.length)).toEqual([]);
});

/** P2-50 follow-up 2: every icon the manifest names is packaged, byte for byte the store's PNG. */
test('the package carries the store icon at every declared size', async () => {
  for (const icon of ICON_FILES) {
    const [built, source] = await Promise.all([readFile(path.join(BUILD_DIR, icon.path)), readFile(path.join(import.meta.dirname, '../../store/icon', icon.source))]);
    expect(built.equals(source), icon.path).toBe(true);
  }
});

/**
 * S-01 / D-14 / security notes §9 bundle content: our content scripts (WXT unlisted scripts) never post to the
 * page, carry no WXT messaging and never name the extension id or a package URL; nothing evaluates strings.
 */
const CONTENT_SCRIPTS = ['cosmetic-specific.js', 'cosmetic-procedural.js', 'cosmetic-generic.js'];

/** A Unicode noncharacter (U+FDD0–FDEF, U+xFFFE, U+xFFFF): Chrome refuses such a content script as "not UTF-8" (P2-24). */
function hasNoncharacter(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) return true;
  }
  return false;
}
const FORBIDDEN = [/postMessage/, /wxt:/, /runtime\.id\b/, /getURL/, /\beval\s*\(/, /new\s+Function/, /innerHTML|outerHTML|insertAdjacentHTML/, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/];

for (const file of CONTENT_SCRIPTS) {
  test(`${file}: no page messaging, no extension id, no string evaluation, no network`, async () => {
    const text = await readFile(path.join(BUILD_DIR, file), 'utf8');
    expect(FORBIDDEN.filter((re) => re.test(text)).map(String)).toEqual([]);
    expect(hasNoncharacter(text), 'a Unicode noncharacter in the bundle').toBe(false);
  });
}

/**
 * P2-47 (D-48's unexplained ≈ 0.4 ms): WXT's `wxt/browser` reads `globalThis.browser?.runtime?.id` when the module
 * loads, and Chrome exposes `browser` to content scripts, so every frame pays the first `runtime` touch of its
 * isolated world (≈ 0.46 ms at 1× vs ≈ 0.03 ms for an empty script, CDP ScriptDuration). Scripts registered on
 * pages reach the extension API lazily, only when they use it.
 */
const PAGE_SCRIPTS = [...CONTENT_SCRIPTS, 'user-cosmetic.js', 'popup-sentinel.js', 'popup-strict.js', 'popup-quiet.js'];
for (const file of PAGE_SCRIPTS) {
  test(`${file}: no extension-API read at load (no WXT browser shim)`, async () => {
    const text = await readFile(path.join(BUILD_DIR, file), 'utf8');
    expect(text).not.toMatch(/globalThis\.browser\??\.runtime/);
  });
}

/** P2-48 / P2-61: the pop-up guard's log-only path (a page-readable decision log) never ships. */
test('the production build carries no log-only marker', async () => {
  expect(await forbiddenMarkers(BUILD_DIR)).toEqual([]);
});

/**
 * The on-demand picker (P2-18/P2-19, design review): it must frame the panel and hand it a port, so it gets its
 * own gate instead of the registered-script one: exactly one `getURL` (the panel), every window
 * `postMessage` with an explicit target (never `'*'`), no save, no string evaluation, no markup, no network.
 */
test('picker.js: one getURL for the panel, no "*" postMessage target, no save, no eval, no markup, no network', async () => {
  const text = await readFile(path.join(BUILD_DIR, 'picker.js'), 'utf8');
  expect(text.match(/getURL\(/g)).toHaveLength(1);
  expect(text).toContain('picker-panel.html');
  expect(text).not.toMatch(/postMessage\([^)]*,\s*["'`]\*["'`]/);
  expect(text).not.toContain('c/saveUserFilter');
  const banned = [/wxt:/, /\beval\s*\(/, /new\s+Function/, /innerHTML|outerHTML|insertAdjacentHTML/, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/];
  expect(banned.filter((re) => re.test(text)).map(String)).toEqual([]);
});

/**
 * P2-43 security review (security notes §10): the worker's own-package reader (`src/platform/catalog.ts`) and, since D-55a,
 * the blocked page's one read of its own packaged `popup-lifted.json` are the only `fetch` calls in our code. The
 * page's is allowed only in that exact shape. No other script of ours carries one, Vite's modulepreload polyfill included.
 * `scriptlets/`, `cosmetic/` (uBO code and filter data that names page APIs) and `surrogates/` are left out.
 */
test('no shipped script of ours but the worker contains fetch, XHR, WebSocket or sendBeacon', async () => {
  const { readdir } = await import('node:fs/promises');
  const ours = (await readdir(BUILD_DIR, { recursive: true }))
    .filter((f) => f.endsWith('.js') && !/^(?:scriptlets|cosmetic|surrogates)[/\\]/.test(f) && f !== 'background.js');
  const ownLiftedRead = /\bfetch\(\w+\.runtime\.getURL\(`\/popup-lifted\.json`\)\)/g;
  const scan = async (f: string): Promise<string[]> => {
    const text = await readFile(path.join(BUILD_DIR, f), 'utf8');
    const rest = /^chunks[/\\]blocked-[\w-]+\.js$/.test(f) ? text.replace(ownLiftedRead, '') : text;
    return /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/.test(rest) ? [f] : [];
  };
  const hits = (await Promise.all(ours.map(scan))).flat();
  expect(ours.length).toBeGreaterThan(10);
  expect(hits).toEqual([]);
});

test('no shipped script widens storage.session to content scripts (setAccessLevel)', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(BUILD_DIR, { recursive: true })).filter((f) => f.endsWith('.js'));
  const hits = (await Promise.all(files.map(async (f) => ((await readFile(path.join(BUILD_DIR, f), 'utf8')).includes('setAccessLevel') ? [f] : [])))).flat();
  expect(hits).toEqual([]);
});

/** `popup-sentinel.js` and its flag files store nothing, make no request and write no markup. */
test('popup-sentinel.js, popup-strict.js, popup-quiet.js: no storage access, no network, no markup', async () => {
  const banned = [/\bstorage\./, /indexedDB/, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/, /innerHTML|outerHTML|insertAdjacentHTML/, /\beval\s*\(/, /new\s+Function/];
  for (const file of ['popup-sentinel.js', 'popup-strict.js', 'popup-quiet.js']) {
    const text = await readFile(path.join(BUILD_DIR, file), 'utf8');
    expect(banned.filter((re) => re.test(text)).map(String), file).toEqual([]);
  }
});

/**
 * ADR-018 (D-54): `popup-sentinel.js` ≤ 5,000 B gzip including the compiled allowlist, hard and final for v1
 * (was 3.0 → 4.0 → 4.2 kB, D-42…D-42b). The v1 sentinel feature set is closed: a raise needs an ADR-018
 * amendment and a new feature or allowlist entry must be byte-neutral. The raw-bytes line (measured 11,600 B
 * + 2 %) catches growth that gzip hides; move it only in a change that says why.
 */
const SENTINEL_GZIP_LIMIT = 5_000;
const SENTINEL_RAW_LIMIT = 11_832;

test('popup-sentinel.js: ≤ 5,000 B gzip and ≤ 11,832 B raw (ADR-018)', async () => {
  const { gzipSync } = await import('node:zlib');
  const text = await readFile(path.join(BUILD_DIR, 'popup-sentinel.js'), 'utf8');
  const raw = Buffer.byteLength(text, 'utf8');
  const gzip = gzipSync(text).length;
  test.info().annotations.push({ type: 'popup-sentinel.js', description: `${String(gzip)} B gzip, ${String(raw)} B raw` });
  expect(gzip).toBeLessThanOrEqual(SENTINEL_GZIP_LIMIT);
  expect(raw).toBeLessThanOrEqual(SENTINEL_RAW_LIMIT);
});
