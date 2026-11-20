/**
 * Packaged paths of the registered content scripts and their data (ADR-010, cosmetic notes §2.1, §3, §6.2).
 * The compiler writes the data files and the scriptlet code; the runtime scripts are WXT unlisted
 * scripts (S-01, D-14) built from `src/entrypoints/<name>.ts` (P1-34, P1-36, P1-37).
 */
import type { ScriptWorld } from '../catalog/registrations.js';

export const RUNTIME_SCRIPTS = {
  /** Takes ISOLATED shard data and adopts the hide / style sheet (P1-34); listed last. */
  cosmetic: 'cosmetic-specific.js',
  /** Message-free glue that starts uBO's procedural engine (P1-36); listed right after the engine. */
  procedural: 'cosmetic-procedural.js',
} as const;

/** uBO's procedural engine, vendored verbatim (ADR-005); listed only where a host has procedural filters. */
export const PROCEDURAL_ENGINE = 'cosmetic/procedural-engine.js';

/** ISOLATED data of one (pack, shard): cosmetic, procedural and ISOLATED scriptlet entries. */
export const isolatedDataPath = (pack: string, shard: number): string => `cosmetic/${pack}/${String(shard)}.js`;
/** MAIN data of one (pack, shard): scriptlet entries. */
export const mainDataPath = (pack: string, shard: number): string => `scriptlets/${pack}/main/${String(shard)}.js`;
/** Scriptlet invocations shared by several shards of one pack and world. */
export const commonDataPath = (pack: string, world: ScriptWorld): string => `scriptlets/${pack}/${world === 'MAIN' ? 'main' : 'isolated'}/common.js`;
/** Scriptlet code of one pack and world: the referenced uBO functions and the dispatcher. */
export const scriptletCodePath = (pack: string, world: ScriptWorld): string => `scriptlets/${pack}.${world === 'MAIN' ? 'main' : 'isolated'}.js`;
