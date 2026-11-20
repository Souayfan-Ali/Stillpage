/**
 * Guards for hostnames taken from filter lists before they reach a `main_frame` rule, a pop-up host
 * list or a match pattern (P1-49 security review). A list line such as `||com^$popup` must not turn
 * into a rule for a whole TLD. Without a bundled Public Suffix List this is a conservative heuristic:
 * a single label, an IP literal or a two-label "ccSLD" (`co.uk`, `com.au`) is treated as a suffix.
 */
import { parseHostname } from '../../src/core/hostname/validate.js';

/** Second-level labels used under two-letter country TLDs as public suffixes. */
const CC_SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gob', 'go', 'gov', 'gv', 'ltd', 'ne', 'net', 'or', 'org', 'plc', 'sch']);
const TLD = /^[a-z]{2,63}$|^xn--[a-z0-9-]{1,59}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** True for something that looks like a public suffix: `com`, `co.uk`, `com.au`. */
export function isSuffixLike(s: string): boolean {
  const labels = s.split('.');
  const [first, last] = [labels[0] ?? '', labels.at(-1) ?? ''];
  if (labels.length === 1) return TLD.test(first);
  return labels.length === 2 && last.length === 2 && CC_SECOND_LEVEL.has(first);
}

/** A host a `main_frame` rule may name: a site host or one full IPv4 address (never a prefix of one). */
export const isRuleHost = (h: string): boolean => isSiteHost(h) || (IPV4.test(h) && h.split('.').every((o) => Number(o) <= 255));

/** A lower-case hostname with a registrable part: not a suffix, not an IP literal, valid labels. */
export function isSiteHost(h: string): boolean {
  return parseHostname(h) === h && h.includes('.') && !isSuffixLike(h) && !IPV4.test(h) && TLD.test(h.slice(h.lastIndexOf('.') + 1));
}
