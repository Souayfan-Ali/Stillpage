/**
 * Hostname validation (P1-03). Dependency-free: content scripts may import it (tooling notes §3).
 * Accepts what `URL.hostname` yields for http(s) pages, minus IPv6 literals: lower-case ASCII
 * (punycode for IDNs), dot-separated labels. Upper case and one trailing dot are normalised.
 */
import type { Hostname } from '../ids.js';
import { MAX_HOSTNAME_LENGTH, MAX_LABEL_LENGTH } from '../limits.js';

/** One label: letters, digits, `-` and `_`, not starting or ending with `-`. */
const ASCII = /^[\u0000-\u007f]*$/;
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;

/**
 * `__proto__` passes the label grammar but is not a DNS name, and as a record key it is swallowed by
 * the prototype setter (accepted, then lost on reload: platform review LOW). Refused outright.
 */
const PROTO_KEY = '__proto__';
/** Whole names a Valibot record drops as keys (`constructor`, `prototype`): refused too (P2-43 review LOW). */
const RECORD_DROPPED = new Set(['constructor', 'prototype']);

function isLabel(label: string): boolean {
  return label.length <= MAX_LABEL_LENGTH && LABEL.test(label) && label !== PROTO_KEY;
}

/** Returns the normalised hostname, or `null` when `value` is not a valid hostname. */
export function parseHostname(value: unknown): Hostname | null {
  // Reject non-ASCII before lower-casing: U+212A (Kelvin sign) lower-cases to `k`.
  if (typeof value !== 'string' || !ASCII.test(value)) return null;
  const lower = value.toLowerCase();
  const name = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  if (name.length === 0 || name.length > MAX_HOSTNAME_LENGTH) return null;
  return name.split('.').every(isLabel) && !RECORD_DROPPED.has(name) ? (name as Hostname) : null;
}

/** One regex for an already-canonical hostname: what `parseHostname(h) === h` accepts, ≈ 6× faster. */
const CANONICAL = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const PROTO_LABEL = /(?:^|\.)__proto__(?:\.|$)/;

/**
 * True when `value` is a hostname in canonical form (lower case, no trailing dot): equal to
 * `parseHostname(value) === value`. For the ≈ 36,000 registration hosts checked on every wake (P1-35).
 */
export function isCanonicalHostname(value: string): boolean {
  return CANONICAL.test(value) && !PROTO_LABEL.test(value) && !RECORD_DROPPED.has(value);
}
