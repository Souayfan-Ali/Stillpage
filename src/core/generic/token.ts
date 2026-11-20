/**
 * Token keys of generic cosmetic filters (P2-23, cosmetic notes §5): the compiler keys a selector on the
 * first `.class` / `#id` of its leftmost compound (outside any functional pseudo-class or attribute
 * selector); the surveyor (P2-24) hashes every class and id it meets with the same function and
 * confirms by exact token. Shared by both sides; pure and dependency-free.
 */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const LOW_16 = 0xffff;
/** Identifier characters: ASCII word characters, `-` and anything non-ASCII. */
// Escaped on purpose: a literal U+FFFF makes Chrome refuse the content script as "not UTF-8" (P2-24).
const IDENT_CHAR = /[A-Za-z0-9_\-\u0080-\uFFFF]/;
const COMBINATOR = /[\s>+~]/;

/** 32-bit FNV-1a of `token` (prefix `.` / `#` included), xor-folded to 16 bits. */
export function tokenHash(token: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < token.length; i += 1) hash = Math.imul(hash ^ token.charCodeAt(i), FNV_PRIME);
  return ((hash >>> 16) ^ hash) & LOW_16;
}

/** The identifier starting at `start`, escapes resolved (`md\:flex` → `md:flex`), and where it ends. */
function readIdent(selector: string, start: number): { readonly name: string; readonly end: number } {
  let name = '';
  let i = start;
  while (i < selector.length) {
    const ch = selector.charAt(i);
    if (ch === '\\' && i + 1 < selector.length) {
      name += selector.charAt(i + 1);
      i += 2;
    } else if (IDENT_CHAR.test(ch)) {
      name += ch;
      i += 1;
    } else {
      break;
    }
  }
  return { name, end: i };
}

/** Scanner state: nesting depth of `(` / `[` and the open quote, if any. */
interface Scan { depth: number; quote: string | null }

/** Advances over one structural character; returns false when `ch` was consumed as structure. */
function isTopLevel(scan: Scan, ch: string): boolean {
  if (scan.quote !== null) {
    if (ch === scan.quote) scan.quote = null;
    return false;
  }
  if (ch === '"' || ch === "'") scan.quote = ch;
  else if (ch === '(' || ch === '[') scan.depth += 1;
  else if (ch === ')' || ch === ']') scan.depth -= 1;
  else return scan.depth === 0;
  return false;
}

/**
 * `.name` / `#name` keying `selector`, or `null` when its leftmost compound has none or the text is a
 * selector list (a top-level comma): such selectors go to the "always" list.
 */
export function leadingToken(selector: string): string | null {
  const scan: Scan = { depth: 0, quote: null };
  let token: string | null = null;
  let inFirstCompound = true;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector.charAt(i);
    if (ch === '\\') {
      i += 1;
    } else if (isTopLevel(scan, ch)) {
      if (ch === ',') return null;
      if (COMBINATOR.test(ch)) inFirstCompound = false;
      else if (inFirstCompound && token === null && (ch === '.' || ch === '#')) {
        const { name, end } = readIdent(selector, i + 1);
        if (name !== '') token = `${ch}${name}`;
        i = end - 1;
      }
    }
  }
  return token;
}
