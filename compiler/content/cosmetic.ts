/**
 * Cosmetic filters → host facts (P1-27, P1-28). Each selector goes through uBO's own selector
 * compiler (ADR-005): plain CSS → `h`, a CSS-able `:style()` → `s` (selector and declarations through
 * `core/sanitise`, security notes §4), anything that needs JavaScript → `p` (uBO's program, run by uBO's
 * engine). `#@#` and `~host` become `u` facts. Generic filters wait for P2-23 and are logged.
 */
import type { Hostname } from '../../src/core/ids.js';
import { sanitiseDeclarations } from '../../src/core/sanitise/declaration.js';
import { sanitiseSelector } from '../../src/core/sanitise/selector.js';
import type { LogEntry } from '../normalise/normalise.js';
import type { ReasonCode } from '../normalise/reasons.js';
import type { Entry, FilterSource } from '../parse/parse-list.js';
import type { UboParser } from '../vendor/ubo.js';
import type { Fact, FactKind } from './facts.js';
import { resolveHost } from './hosts.js';

export interface FactsResult {
  readonly facts: readonly Fact[];
  readonly log: readonly LogEntry[];
  /** Entity names with no observed host (D-20), with the filters that lost them. */
  readonly lostEntities: readonly string[];
}

export interface HostContext {
  readonly stems: ReadonlyMap<string, readonly string[]>;
}

interface Domains { readonly positive: readonly string[]; readonly negative: readonly string[] }

/** Positive and negated (`~`) domains of a cosmetic or scriptlet node. */
export function domainsOf(entry: Entry): Domains {
  const node = entry.node;
  const children = node?.category === 'Cosmetic' ? node.domains.children : [];
  return { positive: children.filter((d) => !d.exception).map((d) => d.value), negative: children.filter((d) => d.exception).map((d) => d.value) };
}

/** The text after the cosmetic separator (`##`, `#@#`, `#?#`, …), exactly as the list wrote it. */
function bodyOf(entry: Entry): string {
  const node = entry.node;
  const sep = node?.category === 'Cosmetic' ? node.separator.value : '##';
  const text = entry.source.text;
  return text.slice(text.indexOf(sep) + sep.length);
}

const log = (source: FilterSource, reason: ReasonCode, detail?: string): LogEntry => ({ source, reason, ...(detail !== undefined && { detail }) });

/** Facts for every resolved host of `domains`; invalid and lost hosts are logged. */
export function hostFacts(entry: Entry, domains: readonly string[], kind: FactKind, value: string, ctx: HostContext): FactsResult {
  const facts: Fact[] = [];
  const logs: LogEntry[] = [];
  const lost: string[] = [];
  for (const d of domains) {
    const r = resolveHost(d, ctx.stems);
    if ('hosts' in r) facts.push(...r.hosts.map((host: Hostname) => ({ host, kind, value, source: entry.source })));
    else if ('lost' in r) lost.push(r.lost);
    else logs.push(log(entry.source, 'content-host-invalid', r.invalid));
  }
  return { facts, log: [...logs, ...lost.map((l) => log(entry.source, 'entity-lost', l))], lostEntities: lost };
}

type Compiled = { readonly kind: 'h' | 's' | 'p'; readonly value: string } | { readonly reason: ReasonCode; readonly detail: string };

/** One selector through uBO's compiler and our sanitiser. */
export function compileCosmetic(body: string, ubo: UboParser): Compiled {
  const c = ubo.compileSelector(body);
  switch (c.kind) {
    case 'invalid':
      return { reason: 'cosmetic-invalid-selector', detail: body };
    case 'css':
      return sanitiseSelector(c.selector) === null ? { reason: 'cosmetic-unsafe', detail: c.selector } : { kind: 'h', value: c.selector };
    case 'style': {
      const css = sanitiseDeclarations(c.declarations)?.css;
      if (sanitiseSelector(c.selector) === null || css === undefined) return { reason: 'cosmetic-unsafe', detail: body };
      return { kind: 's', value: JSON.stringify([c.selector, css]) };
    }
    case 'procedural': {
      const program = sanitiseProgram(c.program);
      return program === null ? { reason: 'cosmetic-unsafe', detail: body } : { kind: 'p', value: program };
    }
  }
}

/**
 * uBO's engine writes a program's `selector` and a `:style()` action into a stylesheet
 * (`cssRuleFromProcedural`), so both pass `core/sanitise` like plain filters (cosmetic notes §3); the style is
 * replaced by its sanitised form. Returns the program text, or null when it is refused.
 */
export function sanitiseProgram(program: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(program);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as { selector?: unknown; action?: unknown };
  if (typeof o.selector === 'string' && o.selector !== '' && sanitiseSelector(o.selector) === null) return null;
  if (!Array.isArray(o.action) || o.action[0] !== 'style') return program;
  const css = sanitiseDeclarations(o.action[1])?.css;
  return css === undefined ? null : JSON.stringify({ ...o, action: ['style', css] });
}

/** Facts of one cosmetic entry (specific, procedural or exception); generic ones are logged. */
export function cosmeticFacts(entry: Entry, ubo: UboParser, ctx: HostContext): FactsResult {
  const { positive, negative } = domainsOf(entry);
  const body = bodyOf(entry);
  if (entry.kind === 'cosmetic.exception') {
    if (positive.length === 0) return { facts: [], log: [log(entry.source, 'cosmetic-generic-exception')], lostEntities: [] };
    const c = compileCosmetic(body, ubo);
    // An exception names the selector as written; uBO matches exceptions on the compiled text.
    return 'reason' in c ? { facts: [], log: [log(entry.source, c.reason, c.detail)], lostEntities: [] } : hostFacts(entry, positive, 'u', c.value, ctx);
  }
  if (positive.length === 0) return { facts: [], log: [log(entry.source, 'cosmetic-generic')], lostEntities: [] };
  const c = compileCosmetic(body, ubo);
  if ('reason' in c) return { facts: [], log: [log(entry.source, c.reason, c.detail)], lostEntities: [] };
  const pos = hostFacts(entry, positive, c.kind, c.value, ctx);
  const neg = hostFacts(entry, negative, 'u', c.value, ctx);
  return { facts: [...pos.facts, ...neg.facts], log: [...pos.log, ...neg.log], lostEntities: [...pos.lostEntities, ...neg.lostEntities] };
}
