/**
 * The pop-up guard's log-only mode, as a contract (P2-61; testing notes §8, pop-up notes §14). A test or nightly
 * build made with `GLASSMERE_POPUP_LOG_ONLY=1` defines `__POPUP_GUARD_LOG_ONLY__ = true`: the guard
 * then blocks nothing and appends each decision to a JSON array on `<html data-sp-log>` (the S-20
 * spike's channel). That attribute is readable by the page, so it exists only in such builds; the
 * reproducible-build check (P2-48) asserts the production build carries neither name. Wiring the
 * define into the build and honouring it in the guard are P2-57's.
 */
import * as v from 'valibot';

export const LOG_ONLY_ENV = 'GLASSMERE_POPUP_LOG_ONLY';
export const LOG_ONLY_DEFINE = '__POPUP_GUARD_LOG_ONLY__';
export const LOG_ATTRIBUTE = 'data-sp-log';

/** One decision: `would-block` in log-only mode; `block` / `allow` as the guard decided them. */
const Decision = v.object({
  v: v.picklist(['block', 'would-block', 'allow']),
  /** Decision-table row (pop-up notes §7.3), e.g. `G11`. */
  why: v.string(),
  url: v.optional(v.string()),
});
export type Decision = v.InferOutput<typeof Decision>;

export type ParsedLog = { readonly ok: true; readonly entries: readonly Decision[] } | { readonly ok: false; readonly error: string };

/** The attribute's text (null when absent) → decisions; anything malformed is refused, never counted. */
export function parseDecisionLog(raw: string | null): ParsedLog {
  if (raw === null) return { ok: true, entries: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'decision log is not JSON' };
  }
  const parsed = v.safeParse(v.array(Decision), json);
  return parsed.success ? { ok: true, entries: parsed.output } : { ok: false, error: `decision log: ${parsed.issues[0].message}` };
}
