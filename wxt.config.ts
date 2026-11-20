import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'wxt';
import { PRODUCT_SLUG } from './src/core/brand.js';
import { bannedPermissionsIn, createManifest, ICON_FILES, readRuleResources, type RuleResource } from './src/core/manifest.js';
import { workerBuildConfig } from './scripts/build/workerMinify.js';

const ROOT = import.meta.dirname;
/** Written by `npm run lists:build` next to the rulesets it puts in `public/` (P1-26). */
const DNR_FRAGMENT = path.join(ROOT, 'dist/compiler/manifest.dnr.json');
/** Message catalogs (P2-40, tooling notes §3: `_locales/` at the root, beside the generated `public/`). */
const LOCALES = path.join(ROOT, '_locales');
/** The store icon's rendered PNGs (P2-50), the one source for the package's icons. */
const ICONS = path.join(ROOT, 'store/icon');

/**
 * The 36 ruleset slots, every `-x` off (D-06). Without a compiler run there is no fragment and no
 * ruleset is declared; with one, every declared file must exist in `public/` or the build fails
 * (Chrome refuses to load an extension whose ruleset file is missing).
 */
function ruleResources(): readonly RuleResource[] {
  if (!existsSync(DNR_FRAGMENT)) return [];
  const resources = readRuleResources(JSON.parse(readFileSync(DNR_FRAGMENT, 'utf8')));
  const missing = resources.filter((r) => !existsSync(path.join(ROOT, 'public', r.path)));
  if (missing.length > 0) throw new Error(`${DNR_FRAGMENT} declares rulesets missing from public/: ${missing.map((r) => r.id).join(', ')}`);
  return resources;
}

// WXT auto-imports are off so Knip and reviewers can see where symbols come from (tooling notes §1).
export default defineConfig({
  srcDir: 'src',
  imports: false,
  manifest: createManifest(ruleResources()),
  // P2-43 security review: Chrome has native modulepreload; Vite's polyfill would ship a `fetch` (security notes §10).
  vite: () => ({ build: { modulePreload: { polyfill: false } } }),
  zip: { artifactTemplate: `${PRODUCT_SLUG}-{{version}}-{{browser}}.zip` },
  hooks: {
    // `_locales` and `store/icon` are source, `public/` is generated: add each catalog and icon to the
    // copied files (WXT's hook API is this list, extended in place).
    'build:publicAssets': (_wxt, files) => {
      for (const locale of readdirSync(LOCALES)) {
        files.push({ absoluteSrc: path.join(LOCALES, locale, 'messages.json'), relativeDest: `_locales/${locale}/messages.json` });
      }
      for (const icon of ICON_FILES) files.push({ absoluteSrc: path.join(ICONS, icon.source), relativeDest: icon.path });
    },
    // D-75 (P3-14): terser for the service worker only; every other group keeps esbuild. WXT's hook API hands
    // over the group's Vite config to extend in place, so its `build` field is replaced, never edited.
    'vite:build:extendConfig': (entrypoints, viteConfig) => {
      const build = workerBuildConfig(entrypoints, viteConfig.build);
      if (build !== undefined) viteConfig.build = build;
    },
    // ADR-007 item 3: no build (and so no zip) ever carries a banned permission (P2-11, design review).
    'build:manifestGenerated': (_wxt, manifest) => {
      const banned = bannedPermissionsIn(manifest);
      if (banned.length > 0) throw new Error(`banned permission in the manifest: ${banned.join(', ')}`);
    },
  },
});
