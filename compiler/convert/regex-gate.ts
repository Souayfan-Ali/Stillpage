/**
 * The converter validates every regex with `chrome.declarativeNetRequest.isRegexSupported` and rejects
 * them all outside a browser. Regex validity is decided later by Chromium itself (P1-23; never
 * re2-wasm, ADR-004 condition 4), so during conversion every regex is accepted and recorded.
 *
 * The converter reads the global `chrome`, so the stub is installed for the duration of one call
 * and conversions are serialised through a queue.
 */

interface RegexOptions {
  readonly regex: string;
}
type Callback = (result: { isSupported: boolean }) => void;

let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` with an accept-all regex validator; returns its result and every regex it saw. */
export function withAcceptAllRegex<T>(fn: () => Promise<T>): Promise<{ value: T; regexes: readonly string[] }> {
  const run = async (): Promise<{ value: T; regexes: readonly string[] }> => {
    const g = globalThis as { chrome?: unknown };
    const previous = g.chrome;
    const regexes: string[] = [];
    const isRegexSupported = (o: RegexOptions, cb: Callback): void => {
      regexes.push(o.regex);
      cb({ isSupported: true });
    };
    g.chrome = { runtime: {}, declarativeNetRequest: { isRegexSupported } };
    try {
      return { value: await fn(), regexes };
    } finally {
      g.chrome = previous;
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
