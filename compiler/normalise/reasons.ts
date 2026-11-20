/**
 * Reason codes for every line the compiler rejects, removes or salvages (filter-pipeline notes §4: an enum; an
 * unknown reason fails the build). `ubolAlso` = uBOL cannot express the filter in DNR either, so it
 * does not count towards the "extra rejections ≤ 1 %" gate (S-02a).
 */
export const REASONS = {
  // Rejected by the uBO-dialect normaliser (uBOL drops them too).
  'ubo-redirect-rule': { ubolAlso: true, note: 'explicit redirect-rule= (DNR cannot redirect only-if-blocked)' },
  'ubo-urlskip': { ubolAlso: true, note: 'urlskip= (not DNR; uBOL ships it as a separate artefact)' },
  'ubo-entity-domain-only': { ubolAlso: true, note: 'only entity domains (example.*) in domain=' },
  'ubo-uritransform-incompatible': { ubolAlso: true, note: 'uritransform= with its own pattern, or on a non-regex filter' },
  'ubo-strict-party': { ubolAlso: true, note: 'strict1p / strict3p' },
  'ubo-ipaddress': { ubolAlso: true, note: 'ipaddress=' },
  'ubo-cname': { ubolAlso: true, note: 'cname' },
  'ubo-replace': { ubolAlso: true, note: 'replace=' },
  'ubo-regex-removeparam': { ubolAlso: true, note: 'regex removeparam= value' },
  'ubo-requestheader': { ubolAlso: true, note: 'requestheader=' },
  'ubo-regex-header': { ubolAlso: true, note: 'header= with a regex value' },
  'ubo-regex-domain': { ubolAlso: true, note: 'regex entry in domain=' },
  // Removed on purpose.
  badfilter: { ubolAlso: true, note: 'cancelled by a $badfilter filter (any list of the build)' },
  // Parse problems.
  'invalid-syntax': { ubolAlso: false, note: 'agtree could not parse the line' },
  'agtree-convert': { ubolAlso: false, note: 'agtree failed to convert uBO syntax to the converter dialect' },
  // Raised by the converter (P1-18).
  'unsupported-modifier': { ubolAlso: false, note: 'modifier the converter does not support' },
  'csp-allow-unresolved': { ubolAlso: false, note: '@@…$csp the converter cannot resolve against the $csp filters' },
  'header-with-method': { ubolAlso: false, note: '$header combined with $method' },
  'converter-misparse': { ubolAlso: false, note: 'the converter mis-parses a $ inside a regex or option value' },
  'empty-domains': { ubolAlso: true, note: 'nothing left in domain= after conversion' },
  'empty-resource-types': { ubolAlso: true, note: 'resource types cancel out' },
  'invalid-declarative-rule': { ubolAlso: false, note: 'the converter produced a rule it considers invalid' },
  'patch-conflict': { ubolAlso: false, note: 'rule merged from filters that need different post-convert patches; left unpatched' },
  // Pop-up filters (filter-pipeline notes §7a, P1-49): every one lands in a rule, the strict-site list or here.
  'popup-generic-pattern': { ubolAlso: false, note: 'host-less, ||* or regex pop-up pattern: on main_frame it could match ordinary navigation (S-18)' },
  'popup-unsupported': { ubolAlso: false, note: 'pop-up filter with an option the main_frame form cannot express' },
  'popup-no-target': { ubolAlso: false, note: 'pop-up filter with neither a URL nor a site (or an exception without a URL)' },
  'popup-invalid-rule': { ubolAlso: false, note: 'the main_frame rule would be refused by Chromium (S-18)' },
  // Raised by the validation step (P1-23).
  'regex-unsupported': { ubolAlso: true, note: 'Chromium isRegexSupported refuses the regex (syntax or the 2 KB memory limit)' },
  'redirect-uncovered': { ubolAlso: false, note: 'redirect dropped because the validation step dropped its covering block (P1-22 invariant)' },
  'invalid-rule-shape': { ubolAlso: false, note: 'a rule shape Chromium refuses to index (it would stop the extension from loading)' },
  // Cosmetic and scriptlet emitters (P1-27…P1-29); not part of the network extra-rejection gate.
  'html-filter': { ubolAlso: true, note: 'HTML filter (##^…): not possible in MV3 (cosmetic notes §1)' },
  'cosmetic-generic': { ubolAlso: false, note: 'generic cosmetic filter: not a specific filter; the generic emitter takes it (P2-23)' },
  'cosmetic-generic-unsupported': { ubolAlso: false, note: 'generic cosmetic filter the generic emitter cannot ship: procedural, :style() or token-less :has() (P2-23)' },
  'cosmetic-generic-exception': { ubolAlso: false, note: 'generic #@# exception: applies to generic filters only (P2-23)' },
  'cosmetic-invalid-selector': { ubolAlso: true, note: "uBO's selector compiler refuses the selector" },
  'cosmetic-unsafe': { ubolAlso: false, note: 'selector or :style() declarations refused by core/sanitise (security notes §4)' },
  'cosmetic-switch-unsupported': { ubolAlso: false, note: 'cosmetic switch ($elemhide, $generichide, …) with a pattern other than ||host^' },
  'content-host-invalid': { ubolAlso: false, note: 'filter host cannot be a match pattern (IP, suffix, single label, regex, non-ASCII after punycode)' },
  'entity-lost': { ubolAlso: false, note: 'entity host (name.*) with no observed name.<suffix> host in the build (D-20)' },
  'scriptlet-generic': { ubolAlso: true, note: 'scriptlet filter without a positive host (needs a wide registration, D-01)' },
  'scriptlet-invalid': { ubolAlso: true, note: "uBO's parser refuses the scriptlet filter" },
  'scriptlet-unknown': { ubolAlso: true, note: 'scriptlet name not in the vendored uBO library (fails the build for default lists)' },
  'scriptlet-untrusted': { ubolAlso: true, note: 'requiresTrust scriptlet from a list that is not trusted (S-03)' },
  'redirect-none': { ubolAlso: false, note: 'redirect=none: compiled as a block at the redirect priority (no resource)' },
  'redirect-unknown': { ubolAlso: true, note: 'redirect resource name not in the vendored uBO resources' },
  'redirect-external': { ubolAlso: true, note: 'redirect to a URL outside the package (security notes §5 rule 5)' },
  'badfilter-outside-pack': { ubolAlso: false, note: '$badfilter of an optional pack whose target is outside that pack: not applied (P2-27, scoped by pack)' },
  'redirect-html-type': { ubolAlso: false, note: 'HTML surrogate on a rule whose types are not only sub_frame (ADR-007 item 6)' },
} as const satisfies Readonly<Record<string, { readonly ubolAlso: boolean; readonly note: string }>>;

export type ReasonCode = keyof typeof REASONS;

/** Salvage transforms applied by the normaliser (one golden test each: `tests/golden/compiler/normalise.json`). */
export const FIXES = [
  'option-anchor',
  'bare-hostname',
  'hosts-line',
  'from-to-domain',
  'drop-reason',
  'drop-entity-domains',
  'top-to-topdomains',
  'popup-also-network',
  'removeparam-doc',
  'uritransform',
  'redirect-implies-block',
  'bare-substring',
  'drop-cosmetic-options',
] as const;

export type FixCode = (typeof FIXES)[number];

/** True when `value` is a known reason code. */
export function isReasonCode(value: string): value is ReasonCode {
  return Object.hasOwn(REASONS, value);
}

/** Throws for an unknown reason (the build must fail rather than log an unclassified loss). */
export function assertReason(value: string): ReasonCode {
  if (!isReasonCode(value)) throw new Error(`unknown rejection reason "${value}"`);
  return value;
}
