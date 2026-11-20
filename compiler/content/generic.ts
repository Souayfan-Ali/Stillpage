/**
 * Generic cosmetic emitter (P2-23, cosmetic notes §5; decisions: design review, P2-23 notes). Host-less cosmetic
 * filters become one packaged data file per pack (`core/generic/data.ts`): a 16-bit token map for
 * selectors that start with a `.class` / `#id`, an "always" list for the rest, the pack's host-less
 * `#@#` exceptions (`unhide`, subtracted from every loaded pack at run time), host exceptions and the
 * `$generichide` / `$elemhide` hosts. Procedural and `:style()` generics, and token-less `:has()`,
 * are logged as unsupported: they would need work on every element of every Thorough page.
 */
import { gzipSync } from 'node:zlib';
import { genericDataPath, genericFileWrap, GENERIC_DATA_VERSION, type GenericData } from '../../src/core/generic/data.js';
import { leadingToken, tokenHash } from '../../src/core/generic/token.js';
import { isSiteHost } from '../entities/hosts.js';
import type { LogEntry } from '../normalise/normalise.js';
import type { Entry } from '../parse/parse-list.js';
import type { UboParser } from '../vendor/ubo.js';
import { compileCosmetic, domainsOf, hostFacts, type HostContext } from './cosmetic.js';
import type { Fact } from './facts.js';

/** One generic entry: a selector to hide (with its `~host` exceptions) or one to un-hide. */
export interface GenericEntry {
  readonly hide?: string;
  readonly unhide?: string;
  readonly exceptions: readonly Fact[];
  readonly log: readonly LogEntry[];
  readonly lostEntities: readonly string[];
}

/** Per-pack counts for the build report. */
export interface GenericStats {
  readonly selectors: number;
  readonly tokens: number;
  readonly always: number;
  readonly unhide: number;
  readonly exceptionHosts: number;
  readonly unsupported: number;
  readonly bytes: number;
  readonly gzipBytes: number;
}

export interface GenericBuild {
  /** Pack → packaged data file, for packs that have one (the `cosmetic-generic` registration lists them). */
  readonly packs: Readonly<Record<string, string>>;
  /** `$generichide` / `$elemhide` hosts, for the registration's `excludeMatches` (P2-25). */
  readonly off: readonly string[];
  readonly files: ReadonlyMap<string, string>;
  readonly stats: Readonly<Record<string, GenericStats>>;
}

/** `@@||host^$generichide` (and `ghide`, `elemhide`, `ehide`): generic hiding off on that host. */
const GENERIC_SWITCH = /^@@\|\|([a-z0-9.-]+)\^\$(?:generichide|ghide|elemhide|ehide)$/;

/** Host of a generic switch, or null (path-bearing patterns and suffixes are not accepted). */
export function genericSwitchHost(entry: Entry): string | null {
  const host = GENERIC_SWITCH.exec(entry.source.text)?.[1];
  return host !== undefined && isSiteHost(host) ? host : null;
}

const unsupported = (entry: Entry, detail: string): GenericEntry =>
  ({ exceptions: [], log: [{ source: entry.source, reason: 'cosmetic-generic-unsupported', detail }], lostEntities: [] });

/** The text after the cosmetic separator. */
function bodyOf(entry: Entry): string {
  const node = entry.node;
  const sep = node?.category === 'Cosmetic' ? node.separator.value : '##';
  return entry.source.text.slice(entry.source.text.indexOf(sep) + sep.length);
}

/** A host-less cosmetic filter or exception as a generic entry; `null` for anything else. */
export function genericEntry(entry: Entry, ubo: UboParser, ctx: HostContext): GenericEntry | null {
  const { positive, negative } = domainsOf(entry);
  const isException = entry.kind === 'cosmetic.exception' && positive.length === 0;
  const isHide = entry.kind === 'cosmetic.generic' || (entry.kind === 'cosmetic.procedural' && positive.length === 0);
  if (!isException && !isHide) return null;
  const c = compileCosmetic(bodyOf(entry), ubo);
  if ('reason' in c) return { exceptions: [], log: [{ source: entry.source, reason: c.reason, detail: c.detail }], lostEntities: [] };
  if (c.kind === 'p') return unsupported(entry, 'procedural');
  if (c.kind === 's') return unsupported(entry, 'style');
  if (isException) return { unhide: c.value, exceptions: [], log: [], lostEntities: [] };
  if (leadingToken(c.value) === null && /:has\(/i.test(c.value)) return unsupported(entry, 'token-less :has()');
  const neg = hostFacts(entry, negative, 'u', c.value, ctx);
  return { hide: c.value, exceptions: neg.facts, log: neg.log, lostEntities: neg.lostEntities };
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(byString);

/** Host exceptions (`u` facts of every pack and the pack's own `~host`) restricted to `selectors`. */
function exceptionRows(selectors: ReadonlySet<string>, exceptions: readonly Fact[]): GenericData['exceptions'] {
  const byHost = new Map<string, Set<string>>();
  for (const f of exceptions) {
    if (f.kind !== 'u' || !selectors.has(f.value)) continue;
    byHost.set(f.host, new Set([...(byHost.get(f.host) ?? []), f.value]));
  }
  return [...byHost.keys()].sort(byString).map((h) => [h, sortedUnique(byHost.get(h) ?? [])] as const);
}

/** The data value of one pack (deterministic: every list sorted). */
function genericData(pack: string, entries: readonly GenericEntry[], hostExceptions: readonly Fact[], off: readonly string[]): GenericData {
  const unhide = sortedUnique(entries.flatMap((e) => (e.unhide === undefined ? [] : [e.unhide])));
  const dropped = new Set(unhide);
  const selectors = sortedUnique(entries.flatMap((e) => (e.hide === undefined || dropped.has(e.hide) ? [] : [e.hide])));
  const tokens: Record<string, number[]> = {};
  const always: number[] = [];
  selectors.forEach((s, i) => {
    const token = leadingToken(s);
    if (token === null) always.push(i);
    else tokens[String(tokenHash(token))] = [...(tokens[String(tokenHash(token))] ?? []), i];
  });
  const own = entries.flatMap((e) => e.exceptions);
  return {
    v: GENERIC_DATA_VERSION, pack, selectors, tokens, always, unhide,
    exceptions: exceptionRows(new Set(selectors), [...own, ...hostExceptions]), off: sortedUnique(off),
  };
}

/** Data files of every pack with generic content, the switch hosts and the per-pack counts. */
export function emitGeneric(perPack: ReadonlyMap<string, readonly GenericEntry[]>, hostExceptions: readonly Fact[], off: readonly string[]): GenericBuild {
  const files = new Map<string, string>();
  const packs: Record<string, string> = {};
  const stats: Record<string, GenericStats> = {};
  const { prefix, suffix } = genericFileWrap();
  for (const pack of [...perPack.keys()].sort(byString)) {
    const entries = perPack.get(pack) ?? [];
    const data = genericData(pack, entries, hostExceptions, off);
    if (data.selectors.length === 0 && data.unhide.length === 0) continue;
    const text = `${prefix}${JSON.stringify(data)}${suffix}`;
    files.set(genericDataPath(pack), text);
    packs[pack] = genericDataPath(pack);
    stats[pack] = {
      selectors: data.selectors.length, tokens: Object.keys(data.tokens).length, always: data.always.length, unhide: data.unhide.length,
      exceptionHosts: data.exceptions.length, unsupported: entries.filter((e) => e.log.some((l) => l.reason === 'cosmetic-generic-unsupported')).length,
      bytes: Buffer.byteLength(text), gzipBytes: gzipSync(text).length,
    };
  }
  return { packs, off: sortedUnique(off), files, stats };
}
