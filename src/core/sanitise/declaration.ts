/**
 * `:style()` declaration sanitiser (P1-33, security notes §4, T6). Used by the compiler at build time and
 * again by content scripts at apply time; dependency-free. Two layers:
 * 1. A denied token anywhere rejects the whole block (no partial parse of hostile text).
 * 2. Every declaration must have balanced parentheses and brackets, or the block is rejected.
 * 3. Each declaration's property must be on the allowlist, which holds no property that can load
 *    a resource by itself; a `position: fixed | sticky` rejects the block (overlays); other
 *    declarations are dropped and reported.
 */
import { MAX_DECLARATION_LENGTH } from '../limits.js';
import { isBalanced } from './balance.js';

/**
 * Lower-case substrings that reject a block. security notes §4 lists `url(`, `image-set(`, `@import`,
 * `expression(`, `\`, `}`, `<`; the rest close the same doors (other resource-loading functions,
 * values from elsewhere, comments and quotes that could hide or split tokens).
 */
export const DENIED_DECLARATION_TOKENS: readonly string[] = Object.freeze([
  'url(',
  'image-set(',
  'image(',
  'cross-fade(',
  'element(',
  'src(',
  'attr(',
  'var(',
  'env(',
  'expression(',
  '@import',
  '@',
  '\\',
  '{',
  '}',
  '<',
  '/*',
  '"',
  "'",
]);

/** Properties a `:style()` filter may set. */
export const ALLOWED_PROPERTIES: ReadonlySet<string> = new Set([
  'display', 'visibility', 'opacity', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'overflow', 'overflow-x', 'overflow-y', 'transform', 'pointer-events', 'clip-path', 'filter',
  'color', 'background', 'background-color', 'border', 'border-color', 'border-width', 'border-style',
  'font-size', 'line-height', 'transition', 'user-select', 'touch-action',
]);

/** Control characters other than tab, line feed and carriage return. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** `position` values that pin an element over the page (overlay / click capture, review MEDIUM). */
const PINNED_POSITION = /^(?:fixed|sticky)\b/i;

/** Sanitised declarations, `prop:value` joined by `;`, and the declarations that were dropped. */
export interface SanitisedDeclarations {
  readonly css: string;
  readonly dropped: readonly string[];
}

function hasDeniedToken(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTROL.test(text) || DENIED_DECLARATION_TOKENS.some((token) => lower.includes(token));
}

/** `position: fixed | sticky` rejects the whole block: it is an overlay, not a hiding rule. */
function isPinnedPosition(declaration: string): boolean {
  const [property = '', value = ''] = declaration.split(':', 2);
  return property.trim().toLowerCase() === 'position' && PINNED_POSITION.test(value.trim());
}

function normalise(declaration: string): string | null {
  const colon = declaration.indexOf(':');
  if (colon < 0) return null;
  const property = declaration.slice(0, colon).trim().toLowerCase();
  const value = declaration.slice(colon + 1).trim();
  if (value === '' || !ALLOWED_PROPERTIES.has(property)) return null;
  return `${property}:${value}`;
}

/** Returns the safe declarations of a `:style()` block, or `null` when it is rejected or empty. */
export function sanitiseDeclarations(text: unknown): SanitisedDeclarations | null {
  if (typeof text !== 'string' || text.length > MAX_DECLARATION_LENGTH || hasDeniedToken(text)) return null;
  const parts = text
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  // Every part must be balanced on its own, so a `;` can never sit inside an open `(` or `[`.
  if (!parts.every(isBalanced) || parts.some(isPinnedPosition)) return null;
  const results = parts.map((part) => ({ part, css: normalise(part) }));
  const kept = results.flatMap((r) => (r.css === null ? [] : [r.css]));
  if (kept.length === 0) return null;
  return { css: kept.join(';'), dropped: results.filter((r) => r.css === null).map((r) => r.part) };
}
