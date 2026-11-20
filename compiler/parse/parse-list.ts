/**
 * Parses one list file into classified entries with their source position (filter-pipeline notes §2 stage 2).
 * Pure: text in, entries out. Hosts-format lists (URLhaus) yield one `network.host` entry per host.
 */
import type { ListConfig } from '../config/schema.js';
import { classify, LINE_KINDS, parseLine, type Classified, type LineKind } from './classify.js';
import { preparse, UBOL_CHROMIUM_ENV } from './preparser.js';

/** Where a filter came from; carried through every stage into the rejection log and the id map. */
export interface FilterSource {
  readonly list: string;
  readonly line: number;
  readonly text: string;
}

export interface Entry extends Classified {
  readonly source: FilterSource;
  /** The list may use `requiresTrust` scriptlets (S-03). */
  readonly trusted: boolean;
}

export interface ParsedList {
  readonly list: string;
  readonly entries: readonly Entry[];
  readonly counts: Readonly<Record<LineKind, number>>;
  readonly ifBlocks: number;
  readonly discardedLines: number;
}

/** Hosts-file housekeeping names that are never blocked. */
const HOSTS_IGNORED = new Set(['localhost', 'localhost.localdomain', 'local', 'broadcasthost', 'ip6-localhost',
  'ip6-loopback', '0.0.0.0']);

function classifyHostsLine(text: string): Classified {
  const t = text.trim();
  if (t === '' || t.startsWith('#') || t.startsWith('!')) return { kind: 'comment' };
  const node = parseLine(t);
  if (node.category !== 'Network' || node.type !== 'HostRule') return { kind: 'invalid', node, detail: 'not a hosts line' };
  const hosts = node.hostnames.children.map((h) => h.value);
  if (hosts.every((h) => HOSTS_IGNORED.has(h))) return { kind: 'comment' };
  return { kind: 'network.host', node };
}

const zeroCounts = (): Record<LineKind, number> =>
  Object.fromEntries(LINE_KINDS.map((k) => [k, 0])) as Record<LineKind, number>;

/** Parses `text` of `list` with the uBOL environment. Throws on `!#include` (pinned lists are pre-resolved). */
export function parseList(list: ListConfig, text: string, env: readonly string[] = UBOL_CHROMIUM_ENV): ParsedList {
  const pre = preparse(text, env);
  const firstInclude = pre.includes[0];
  if (firstInclude) throw new Error(`list "${list.id}" line ${String(firstInclude.line)}: !#include is not supported; pin the resolved file`);
  const counts = zeroCounts();
  const entries: Entry[] = [];
  for (const { line, text: raw } of pre.lines) {
    const c = list.format === 'hosts' ? classifyHostsLine(raw) : classify(raw);
    counts[c.kind] += 1;
    if (c.kind !== 'comment') entries.push({ ...c, source: { list: list.id, line, text: raw.trim() }, trusted: list.trusted });
  }
  return { list: list.id, entries, counts, ifBlocks: pre.ifBlocks, discardedLines: pre.discardedLines };
}
