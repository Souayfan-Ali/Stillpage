/**
 * Selector sanitiser (P1-33, security notes §4 rule 3). Syntactic and dependency-free, so the compiler and
 * content scripts share it; content scripts still let `CSSStyleSheet` parse the result in a
 * `try/catch`. The guarantee: an accepted selector cannot leave its rule (no braces, no at-rule,
 * no comment, no `url(`, no letter or digit escapes, balanced strings, brackets and parentheses),
 * so `selector{declarations}` is one rule. Content scripts should still insert rules one at a time.
 */
import { MAX_SELECTOR_LENGTH } from '../limits.js';
import { isBalanced } from './balance.js';
import { sanitiseDeclarations } from './declaration.js';

/** The only declaration a stock selector is ever applied with (security notes §4 rule 1). */
export const HIDE_DECLARATION = 'display:none!important';

/** `url(` is denied outright: the CSS tokenizer reads it as a URL token, not as a function (review HIGH). */
const DENIED = ['{', '}', '<', '/*', 'url('] as const;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Returns the trimmed selector, or `null` when it is unsafe or malformed. */
export function sanitiseSelector(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const selector = text.trim();
  if (selector === '' || selector.length > MAX_SELECTOR_LENGTH || selector.startsWith('@')) return null;
  if (CONTROL.test(selector) || DENIED.some((token) => selector.toLowerCase().includes(token))) return null;
  return isBalanced(selector) ? selector : null;
}

/** `selector{display:none!important}`, or `null` for an unsafe selector. */
export function hideRule(selector: string): string | null {
  const safe = sanitiseSelector(selector);
  return safe === null ? null : `${safe}{${HIDE_DECLARATION}}`;
}

/** A `:style()` rule with sanitised declarations, or `null` when either part is rejected. */
export function styleRule(selector: string, declarations: string): string | null {
  const safe = sanitiseSelector(selector);
  const css = sanitiseDeclarations(declarations)?.css;
  return safe === null || css === undefined ? null : `${safe}{${css}}`;
}
