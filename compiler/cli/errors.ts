/** One link of the chain as text: an Error's message, a string as is, anything else as JSON (never throws). */
function linkText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  // `JSON.stringify` has no text for these two.
  if (typeof value === 'symbol' || typeof value === 'function') return typeof value;
  return JSON.stringify(value);
}

/** Text of a CLI's top-level failure (P2-44): the message and its whole `cause` chain, one line each. */
export function errorText(error: unknown): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    lines.push(linkText(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return lines.join('\n  caused by: ');
}
