/**
 * Redirect targets → packaged surrogates (P1-30, security notes §5 rule 5). The converter names its own
 * resource paths; here every resource redirect is re-pointed at uBO's resource named by the source
 * filter (`redirect=` / ABP `rewrite=`, aliases, `:N` / `:-N` priority suffix), which ships as
 * `surrogates/<file>`. `redirect=none` becomes a plain `block` at the redirect's priority (D-24); an
 * unknown name or a URL outside the package is dropped and logged; an HTML surrogate is used only on
 * rules whose types are exactly `sub_frame` (D-24 condition 3).
 */
import type { ConvertedRule } from '../convert/convert.js';
import type { LogEntry } from '../normalise/normalise.js';
import type { ReasonCode } from '../normalise/reasons.js';
import type { RedirectResource } from '../vendor/resources.js';

/** Where surrogates live in the package (web-accessible with `use_dynamic_url`, ADR-007). */
export const SURROGATE_DIR = 'surrogates';
const NAME = /[$,](?:redirect|rewrite)=([^,$]+)/;
const PRIORITY_SUFFIX = /:-?\d+$/;

export interface RedirectResult {
  readonly rules: readonly ConvertedRule[];
  readonly log: readonly LogEntry[];
  /** `redirect=none` rules compiled as blocks. */
  readonly none: number;
}

/** Name or alias → uBO file name. */
export function resourceIndex(resources: readonly RedirectResource[]): ReadonlyMap<string, string> {
  return new Map(resources.flatMap((r) => [[r.name, r.name] as const, ...r.aliases.map((a) => [a, r.name] as const)]));
}

/** The resource name of a redirect filter, without its priority suffix. */
export function redirectName(filter: string): string | undefined {
  return NAME.exec(filter)?.[1]?.replace(PRIORITY_SUFFIX, '');
}

const FRAME_TYPES = new Set(['main_frame', 'sub_frame', 'object']);

/**
 * Surrogates a browser may render as a document (script could run in the extension origin, review H2):
 * the gated HTML file only on rules whose types are exactly `sub_frame` (D-24); XML/SVG never on a frame
 * type, so they are served to XHR and media requests only.
 */
export function wrongDocumentTypes(file: string, types: readonly string[] | undefined): boolean {
  if (/\.html?$/i.test(file)) return types?.length !== 1 || types[0] !== 'sub_frame';
  if (/\.(?:xhtml|xml|svg)$/i.test(file)) return types === undefined || types.some((t) => FRAME_TYPES.has(t));
  return false;
}
/**
 * A `regexSubstitution` may only re-assemble captured parts of the request URL (`\1\2`: uBO's
 * `uritransform` removes text); anything else could point the request anywhere (security review H1).
 */
export const isSafeSubstitution = (s: string): boolean => /^(?:\\[0-9])+$/.test(s);
/** A `transform` may change the query or path only, never where the request goes. */
const movesRequest = (t: object | undefined): boolean => t !== undefined && ['host', 'scheme', 'port', 'username', 'password'].some((k) => k in t);

type Outcome = { readonly rule: ConvertedRule; readonly none?: true } | { readonly reason: ReasonCode; readonly detail: string };

function resolveOne(r: ConvertedRule, index: ReadonlyMap<string, string>): Outcome {
  const redirect = r.rule.action.redirect;
  if (r.rule.action.type !== 'redirect' || redirect === undefined) return { rule: r };
  if (redirect.url !== undefined) return { reason: 'redirect-external', detail: redirect.url };
  if (redirect.regexSubstitution !== undefined && !isSafeSubstitution(redirect.regexSubstitution)) return { reason: 'redirect-external', detail: redirect.regexSubstitution };
  if (movesRequest(redirect.transform)) return { reason: 'redirect-external', detail: JSON.stringify(redirect.transform) };
  if (redirect.extensionPath === undefined) return { rule: r }; // query transform / safe substitution: no resource
  const name = redirectName(r.sources[0]?.source.text ?? '') ?? '';
  if (name === 'none') {
    return { rule: { ...r, rule: { ...r.rule, action: { type: 'block' } } }, none: true };
  }
  const file = index.get(name);
  if (file === undefined) return { reason: 'redirect-unknown', detail: name };
  if (wrongDocumentTypes(file, r.rule.condition.resourceTypes)) return { reason: 'redirect-html-type', detail: name };
  return { rule: { ...r, rule: { ...r.rule, action: { ...r.rule.action, redirect: { extensionPath: `/${SURROGATE_DIR}/${file}` } } } } };
}

/** Re-points every resource redirect of `rules`; returns new rules, the log and the files used. */
export function resolveRedirects(rules: readonly ConvertedRule[], index: ReadonlyMap<string, string>): RedirectResult {
  const outcomes = rules.map((r) => [r, resolveOne(r, index)] as const);
  const log = outcomes.flatMap(([r, o]) => ('reason' in o ? r.sources.map((s) => ({ source: s.source, reason: o.reason, detail: o.detail })) : []));
  const kept = outcomes.flatMap(([, o]) => ('rule' in o ? [o] : []));
  return {
    rules: kept.map((o) => o.rule), log,
    none: kept.filter((o) => o.none === true).length,
  };
}
