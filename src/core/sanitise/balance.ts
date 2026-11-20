/**
 * Bracket and quote scanner shared by the selector and declaration sanitisers (P1-33). An accepted
 * text cannot leave an open `(`, `[` or string behind, which would swallow the `}` of its own rule
 * and the rules after it in a joined stylesheet (security review, HIGH).
 */

const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[' };
/** After a backslash outside a string, only punctuation may follow: an escaped letter or digit can spell `url(`. */
const SAFE_ESCAPE = /^[!-/:-@[-`{-~]$/;

/** True when quotes, parentheses and brackets are balanced and every escape is safe. */
export function isBalanced(text: string): boolean {
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\\') {
      // A trailing backslash would escape the `{` appended after the text.
      const next = text.charAt(i + 1);
      if (next === '' || (quote === null && !SAFE_ESCAPE.test(next))) return false;
      i += 1;
    } else if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      stack.push(ch);
    } else if (ch in CLOSERS && stack.pop() !== CLOSERS[ch]) {
      return false;
    }
  }
  return quote === null && stack.length === 0;
}
