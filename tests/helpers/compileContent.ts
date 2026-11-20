/**
 * Filter lines → shard data files, scriptlet code and registrations through the real content compiler
 * (P1-27…P1-29), for test data written as filters (the fixture corpus, testing notes §3). Vitest-free, so the
 * Playwright helpers can use it. Needs the vendored uBO files (`npm run vendor:fetch`).
 */
import { buildContent, type ContentBuild } from '../../compiler/content/build.js';
import { stemIndex } from '../../compiler/entities/expand.js';
import { classify } from '../../compiler/parse/classify.js';
import { loadLibrary, scriptletPort } from '../../compiler/scriptlets/port.js';
import { loadVendorLock, vendorReader } from '../../compiler/vendor/node-ports.js';
import { loadUboParser } from '../../compiler/vendor/ubo.js';
import { PROCEDURAL_ENGINE } from '../../src/core/content/files.js';

const ENGINE_FILE = 'platform/mv3/extension/js/scripting/css-procedural-api.js';

export interface CompiledContent {
  readonly build: ContentBuild;
  /** Every packaged file the registrations list that the compiler writes (data, code, the engine). */
  readonly files: ReadonlyMap<string, string>;
}

/**
 * Compiles `lines` as one trusted list of `pack`. `knownHosts` stands in for the hosts the rest of a
 * real build names, which observed entity expansion (D-20) draws on.
 */
export async function compileContent(lines: readonly string[], pack: string, knownHosts: readonly string[] = []): Promise<CompiledContent> {
  const lock = await loadVendorLock();
  const ubo = await loadUboParser(lock);
  const port = scriptletPort(await loadLibrary(lock), ubo, lock.commit);
  const entries = lines.map((text, i) => ({ ...classify(text), source: { list: 'fx', line: i + 1, text }, trusted: true }));
  const build = buildContent([{ config: { id: pack, pack }, entries }], ubo, { stems: stemIndex(knownHosts) }, port);
  const engine = (await vendorReader(lock)(ENGINE_FILE)).toString('utf8');
  const usesEngine = [...build.registrations.values()].flat().some((r) => r.js.includes(PROCEDURAL_ENGINE));
  return { build, files: new Map([...build.files, ...(usesEngine ? [[PROCEDURAL_ENGINE, engine] as const] : [])]) };
}
