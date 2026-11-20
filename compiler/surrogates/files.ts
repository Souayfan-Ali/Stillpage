/**
 * Surrogate files to package (P1-30): exactly the uBO resources the emitted `-x` rules redirect to,
 * from the hash-checked vendor copy. HTML surrogates are allowed only on the D-24 allowlist with
 * their pinned SHA-256 and must pass an independent content gate (ADR-007 item 6 as amended).
 */
import { createHash } from 'node:crypto';
import type { DnrRule } from '../dnr/schema.js';
import { isSafeSubstitution, SURROGATE_DIR, wrongDocumentTypes } from './redirects.js';

/** The one inert HTML surrogate (uBO `noop.html` at `2bc679d9`, D-24). Adding one needs an ADR amendment. */
const HTML_SURROGATES: Readonly<Record<string, string>> = { 'noop.html': 'cee0f0272bae8618bb36b96eae44057ad7ad8325afc0096e2477713b146e1adc' };

/** Constructs an inert HTML surrogate must not contain (D-24 condition 2). */
const FORBIDDEN_HTML = [/<script/i, /\son[a-z]+\s*=/i, /javascript:/i, /<meta/i, /<(?:link|img|iframe|frame|object|embed|form|base|svg|video|audio|source)\b/i, /<a\s[^>]*href/i, /url\(/i, /@import/i];

/** Problems of an HTML surrogate; empty when it may ship. */
export function htmlSurrogateProblems(file: string, bytes: Uint8Array): readonly string[] {
  const want = Object.hasOwn(HTML_SURROGATES, file) ? HTML_SURROGATES[file] : undefined;
  const got = createHash('sha256').update(bytes).digest('hex');
  const text = new TextDecoder().decode(bytes);
  return [
    ...(want === undefined ? [`${file}: HTML surrogate not on the D-24 allowlist`] : got === want ? [] : [`${file}: SHA-256 ${got} is not the pinned one`]),
    ...FORBIDDEN_HTML.filter((re) => re.test(text)).map((re) => `${file}: contains ${re.source}`),
  ];
}

/**
 * File types a surrogate may have (security review H2): scripts, images, media, text, JSON, CSS, uBO's
 * extensionless `empty`, VAST/VMAP XML (served to XHR only, `redirect-html-type` keeps them off frames)
 * and the one gated HTML file. Anything else fails the build.
 */
const SHIPPABLE = /^(?:[a-z0-9_.-]+\.(?:js|gif|png|mp3|mp4|txt|json|css|xml|html)|empty)$/i;

/** File names under `surrogates/` that `rules` redirect to, sorted. */
export function surrogatesUsed(rules: readonly DnrRule[]): readonly string[] {
  const prefix = `/${SURROGATE_DIR}/`;
  return [...new Set(rules.flatMap((r) => {
    const p = r.action.redirect?.extensionPath;
    return p?.startsWith(prefix) ? [p.slice(prefix.length)] : [];
  }))].sort();
}

/** Packaged path → bytes for `used`; throws when a file is missing or an HTML surrogate fails its gate. */
export function surrogateFiles(used: readonly string[], bytes: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, Uint8Array> {
  return new Map(used.map((f) => {
    const b = bytes.get(f);
    if (b === undefined) throw new Error(`surrogate "${f}" is not among the vendored resources`);
    const problems = [...(SHIPPABLE.test(f) ? [] : [`surrogate "${f}" has a file type that may not ship`]),
      ...(/\.html?$/i.test(f) ? htmlSurrogateProblems(f, b) : [])];
    if (problems.length > 0) throw new Error(problems.join('; '));
    return [`${SURROGATE_DIR}/${f}`, b] as const;
  }));
}

/** Verify stage: every redirect of `rules` targets a packaged surrogate; no redirect leaves the package. */
export function redirectProblems(rules: readonly DnrRule[], packaged: ReadonlyMap<string, Uint8Array>): readonly string[] {
  const redirects = rules.filter((r) => r.action.type === 'redirect');
  const external = redirects.filter((r) => r.action.redirect?.url !== undefined).length;
  const missing = redirects.flatMap((r) => {
    const p = r.action.redirect?.extensionPath;
    return p !== undefined && (!p.startsWith(`/${SURROGATE_DIR}/`) || !packaged.has(p.slice(1))) ? [p] : [];
  });
  const substitutions = redirects.filter((r) => r.action.redirect?.regexSubstitution !== undefined && !isSafeSubstitution(r.action.redirect.regexSubstitution)).length;
  const documents = redirects.filter((r) => wrongDocumentTypes(r.action.redirect?.extensionPath ?? '', r.condition.resourceTypes)).length;
  return [
    ...(external > 0 ? [`${String(external)} redirect(s) to a URL outside the package`] : []),
    ...(substitutions > 0 ? [`${String(substitutions)} regexSubstitution redirect(s) that do more than remove text`] : []),
    ...(documents > 0 ? [`${String(documents)} redirect(s) to a document surrogate (HTML, XML) on types it may not serve`] : []),
    ...[...new Set(missing)].map((p) => `redirect target ${p} is not packaged`),
  ];
}
