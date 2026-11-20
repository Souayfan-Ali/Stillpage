/**
 * Host facts (P1-27, P1-28, P1-29): every cosmetic or scriptlet filter becomes facts
 * `(host, kind, value)` before it is sharded. `u` and `n` facts are exceptions; they are resolved here
 * at build time as far as they can be, across packs too (ADR-010 condition), and what still has to
 * cancel an entry inherited from a parent host stays as a runtime exception.
 */
import { parentDomains } from '../../src/core/hostname/walk.js';
import type { Hostname } from '../../src/core/ids.js';
import type { FilterSource } from '../parse/parse-list.js';

/** `h` hide, `s` style, `p` procedural, `j` scriptlet; `u` / `n` cancel `h` / `j` here and below. */
export type FactKind = 'h' | 'u' | 's' | 'p' | 'j' | 'n';

export interface Fact {
  readonly host: Hostname;
  readonly kind: FactKind;
  /** Selector (`h`, `u`), `JSON [selector, declarations]` (`s`), uBO program (`p`), `JSON [name, ...args]` (`j`, `n`). */
  readonly value: string;
  readonly source: FilterSource;
}

/** Which positive kind an exception kind cancels at run time (`s` and `p` exceptions resolve at build time only). */
const CANCELS: Partial<Record<FactKind, FactKind>> = { u: 'h', n: 'j' };

export interface ResolvedFacts {
  readonly facts: readonly Fact[];
  /** Positive facts removed or cancelled by an exception of another pack (fail-open: applies even when that pack is off). */
  readonly failOpen: number;
  /** Positive facts removed because an exception covers their host. */
  readonly removed: number;
  /** `:style()` / procedural exceptions on a sub-host of a filter host: not expressible at run time, left applied (fail-closed). */
  readonly unresolved: number;
}

/** The exception kind that cancels a positive kind. */
const EXCEPTION_OF: Partial<Record<FactKind, FactKind>> = { h: 'u', s: 'u', p: 'u', j: 'n' };

const key = (kind: FactKind, value: string, host: string): string => `${kind}\u0000${value}\u0000${host}`;

/** True when an exception of `kind`/`value` sits on `host` or a parent of it. */
function coveredBy(exceptions: ReadonlySet<string>, kind: FactKind, value: string, host: Hostname): boolean {
  return parentDomains(host).some((name) => exceptions.has(key(kind, value, name)));
}

/**
 * Resolves exceptions for one pack's facts. `exceptions` are the exception facts of every pack;
 * `own` marks which of them belong to this pack (for the fail-open count). A positive fact covered
 * by an exception on its host or a parent is dropped; an exception is kept only where it must cancel
 * a positive fact of a strict parent host at run time. Returns new arrays; inputs are untouched.
 */
export function resolveExceptions(facts: readonly Fact[], exceptions: readonly Fact[], own: ReadonlySet<Fact>): ResolvedFacts {
  const allKeys = new Set(exceptions.map((e) => key(e.kind, e.value, e.host)));
  const ownKeys = new Set(exceptions.filter((e) => own.has(e)).map((e) => key(e.kind, e.value, e.host)));
  const positives = facts.filter((f) => CANCELS[f.kind] === undefined);
  let failOpen = 0;
  const kept = positives.filter((f) => {
    const exceptionKind = EXCEPTION_OF[f.kind];
    if (exceptionKind === undefined || !coveredBy(allKeys, exceptionKind, f.value, f.host)) return true;
    if (!coveredBy(ownKeys, exceptionKind, f.value, f.host)) failOpen += 1;
    return false;
  });
  const positiveKeys = new Set(kept.map((f) => key(f.kind, f.value, f.host)));
  const runtime = exceptions.filter((e) => {
    const cancels = CANCELS[e.kind];
    return cancels !== undefined && parentDomains(e.host).slice(1).some((p) => positiveKeys.has(key(cancels, e.value, p)));
  });
  const runtimeFromOthers = runtime.filter((e) => !own.has(e)).length;
  const keptValues = new Set(kept.filter((f) => f.kind === 's' || f.kind === 'p').map((f) => `${f.value}\u0000${f.host}`));
  const unresolved = exceptions.filter((e) => e.kind === 'u' && parentDomains(e.host).slice(1).some((p) => keptValues.has(`${e.value}\u0000${p}`))).length;
  return { facts: [...kept, ...dedupeFacts(runtime)], failOpen: failOpen + runtimeFromOthers, removed: positives.length - kept.length, unresolved };
}

/** One fact per (kind, value, host); the first source wins (input order is list order). */
export function dedupeFacts(facts: readonly Fact[]): readonly Fact[] {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const k = key(f.kind, f.value, f.host);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
