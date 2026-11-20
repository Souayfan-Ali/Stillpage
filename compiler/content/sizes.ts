/**
 * Scriptlet size accounting (D-22): code per pack, and the dispatch data of the default packs as
 * "attributable bytes" in one gzip stream — MAIN shard files, both common tables, and from the
 * ISOLATED shard files the invocation tables, the scriptlet part of each entry, and the host strings of
 * hosts that carry scriptlets only (hosts with cosmetic data are paid for by the cosmetic line).
 */
import { gzipSync } from 'node:zlib';
import { scriptletCodePath } from '../../src/core/content/files.js';
import type { HostEntry } from '../../src/core/content/shard-data.js';
import { readShardFile } from '../verify/content.js';

export interface ScriptletSizes {
  readonly dispatch: { readonly raw: number; readonly gzip: number };
  readonly code: { readonly raw: number; readonly gzip: number; readonly byPack: Readonly<Record<string, number>> };
}

const gzip = (text: string): number => gzipSync(text, { level: 9 }).length;
const COSMETIC_FIELDS = ['h', 'u', 's', 'p'] as const;

function isolatedShare(text: string): string {
  const data = readShardFile(text, 'ISOLATED');
  if (data === null) return '';
  const parts = data.entries.map((e: HostEntry, i) => {
    if (e.j === undefined && e.n === undefined) return '';
    const onlyScriptlets = COSMETIC_FIELDS.every((k) => e[k] === undefined);
    return `${onlyScriptlets ? JSON.stringify(data.hosts[i]) : ''}${JSON.stringify({ j: e.j, n: e.n })}`;
  });
  return `${JSON.stringify(data.invocations)}${parts.join('')}`;
}

/** Sizes over the shipped files of `packs` (sorted paths, so the gzip figure is deterministic). */
export function scriptletSizes(files: ReadonlyMap<string, string>, packs: readonly string[]): ScriptletSizes {
  const paths = [...files.keys()].sort();
  const of = (pack: string) => paths.filter((p) => p.startsWith(`scriptlets/${pack}/`) || p.startsWith(`cosmetic/${pack}/`));
  const dispatch = packs.flatMap(of).map((p) => {
    const text = files.get(p) ?? '';
    return p.startsWith('cosmetic/') ? isolatedShare(text) : text;
  }).join('');
  const codes = packs.map((pack) => [pack, ['MAIN', 'ISOLATED'].map((w) => files.get(scriptletCodePath(pack, w as 'MAIN')) ?? '').join('')] as const);
  const code = codes.map(([, t]) => t).join('');
  return {
    dispatch: { raw: Buffer.byteLength(dispatch), gzip: gzip(dispatch) },
    code: { raw: Buffer.byteLength(code), gzip: codes.reduce((n, [, t]) => n + (t === '' ? 0 : gzip(t)), 0), byPack: Object.fromEntries(codes.map(([p, t]) => [p, t === '' ? 0 : gzip(t)])) },
  };
}

/**
 * Per-pack code gate (D-22 / D-27, P2-47): every pack that can be enabled, not only the default ones, keeps
 * its MAIN + ISOLATED scriptlet code within `limit` B gzip.
 */
export function oversizedPackCode(files: ReadonlyMap<string, string>, packs: readonly string[], limit: number): string[] {
  return Object.entries(scriptletSizes(files, packs).code.byPack)
    .filter(([, g]) => g > limit)
    .map(([p, g]) => `scriptlet code of ${p}: ${String(g)} B gzip > ${String(limit)}`);
}
