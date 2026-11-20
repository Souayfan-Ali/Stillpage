/**
 * The differential allowlist (filter-pipeline notes §11, testing notes §5, ADR-004): every class of verdict difference
 * between uBOL and us that is understood. Exactly one class is excluded from the ≥ 99 % gate —
 * `main_frame` strict blocking (S-02c A1–A3, decided in the Phase 0 review, D-11) — and the raw
 * figure is always reported beside the adjusted one. Every other class is explained but still counts
 * against the gate; the `follow-up` ones are compiler gaps found by this suite (P1-45 notes), fixed
 * in `1620845`: they stay as tripwires with ceiling 0, so a regression fails instead of being explained.
 * A difference that no class explains fails the suite. Classes are tried in order.
 */
import type { Verdict } from '../support/verdict.js';

/** The parts of a DNR rule the classes look at. */
export interface RuleFacts {
  readonly action: { readonly type: string; readonly redirect?: object };
  readonly condition: { readonly urlFilter?: string; readonly resourceTypes?: readonly string[] };
}

export interface Difference {
  readonly type: string;
  /** The request URL (classes that depend on its shape). */
  readonly url: string;
  /** Verdicts as S-02c defined them: a lone `modifyHeaders` match counts as `none`. */
  readonly ubol: Verdict;
  readonly ours: Verdict;
  /** uBOL's deciding rule redirects to its strict-block page (`strictblock.html`). */
  readonly ubolStrictBlock: boolean;
  readonly ubolRule: RuleFacts | null;
  readonly ourRule: RuleFacts | null;
}

export interface DifferenceClass {
  readonly id: string;
  readonly explanation: string;
  /** True only for the one class the gate leaves out. */
  readonly excludedFromGate: boolean;
  /** Most requests the class may explain; more fails the suite (a narrow class must stay narrow). */
  readonly ceiling?: number;
  readonly matches: (d: Difference) => boolean;
}

const passes = (v: Verdict): boolean => v === 'none' || v === 'allow';
const HOST_LIKE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;

export const DIFFERENCE_CLASSES: readonly DifferenceClass[] = [
  {
    id: 'main_frame-strict-block',
    explanation:
      'uBO strict blocking of navigations (S-02c A1–A3, D-11): uBOL redirects a navigation to its strictblock.html interstitial where we keep a static main_frame block (A1), we block a $doc/$all host uBOL does not (A2), or uBOL strict-blocks a host listed only by a plain ||host^ ad/tracker filter that we let through (A3).',
    excludedFromGate: true,
    // A2 only when our deciding rule is an explicit navigation block ($doc/$all), never any block.
    matches: (d) => d.type === 'main_frame' && (d.ubolStrictBlock || (d.ours === 'block' && d.ourRule?.condition.resourceTypes?.includes('main_frame') === true)),
  },
  {
    id: 'same-outcome-pass',
    explanation:
      'Both sides let the request through; one names an exception (allow), the other nothing (S-02c A4/B: an exception of one list with nothing to cancel).',
    excludedFromGate: false,
    matches: (d) => passes(d.ubol) && passes(d.ours),
  },
  {
    id: 'ubol-unanchored-ip-literal',
    explanation:
      'uBOL compiles `||[::]^` (an IPv6 literal) without its host anchor, as urlFilter `[::]^`, so it matches "[::]" anywhere in a URL; we keep the anchor. The rule-derived corpus puts "[::]" into paths.',
    excludedFromGate: false,
    matches: (d) => (d.ubolRule?.condition.urlFilter ?? '').startsWith('[') && passes(d.ours),
  },
  {
    id: 'removeparam-form',
    explanation:
      'uBOL writes $removeparam as urlFilter + queryTransform (e.g. `://youtube.com/@*?si=`), the converter as a host-anchored regex; they differ only on URLs that embed another address, which the corpus generator produces (P1-31 count-oracle follow-up).',
    excludedFromGate: false,
    matches: (d) => d.ubol === 'redirect' && JSON.stringify(d.ubolRule?.action.redirect ?? {}).includes('queryTransform') && passes(d.ours),
  },
  {
    id: 'noop-query-redirect-masks-same-ruleset',
    explanation:
      'Measured Chrome behaviour (P1-35 batch probe): a `removeparam` (queryTransform) redirect that wins the priority contest but changes nothing — the URL has no query — is dropped together with the lower-priority rules of its own ruleset, while other rulesets still decide. uBOL keeps `@@||v.fwmrm.net/ad/*html5_live^$script,domain=channel4.com` (allow, 30) beside the uBO Lite list\'s `…$important,removeparam=caid` (redirect, 31) in one ruleset, so on a query-less URL its allow is masked and EasyList\'s generic `fwmrm.net` block (another ruleset) decides. We split unsafe rules into `-x` (D-06), so our no-op redirect masks nothing and the allow stands — uBO\'s own semantics (the exception allows the script; removeparam only edits a query). Not a compiler difference: matching uBOL would mean co-locating allows with redirects.',
    excludedFromGate: false,
    ceiling: 5,
    matches: (d) => d.ubol === 'block' && d.ours === 'allow' && d.ourRule?.action.type === 'allow' && !d.url.includes('?'),
  },
  {
    id: 'follow-up-bare-pattern-as-hostname',
    explanation:
      'Compiler gap: our uBO-dialect normaliser takes a bare pattern that looks like a hostname (EasyPrivacy `_chartbeat.js`) as `||host^`; uBO and uBOL keep it as a URL pattern. Follow-up for compiler/normalise.',
    excludedFromGate: false,
    ceiling: 0,
    matches: (d) => d.ubol === 'block' && passes(d.ours) && HOST_LIKE.test(d.ubolRule?.condition.urlFilter ?? ''),
  },
  {
    id: 'companion-block-covers-every-type',
    explanation:
      'Design difference, decided (P1-22, D-06; narrowing tried and reverted in the content batch, 15 new differences): every redirect gets a companion block so that blocking survives without host access, and for a type-less `redirect=` filter that block is type-less too — uBO\'s own semantics (its block half applies to every type). uBOL ships the redirect alone, so a type the resource cannot serve (websocket) passes there and is blocked here.',
    excludedFromGate: false,
    ceiling: 5,
    matches: (d) => d.type === 'websocket' && d.ours === 'block' && passes(d.ubol),
  },
  {
    id: 'follow-up-cosmetic-option-widens-exception',
    explanation:
      'Compiler gap: an exception with a cosmetic option (`@@*$script,xhr,ghide,domain=…`) is converted with main_frame and sub_frame added to its types, so it also allows frames; uBOL keeps only the network types. Follow-up for compiler/normalise.',
    excludedFromGate: false,
    ceiling: 0,
    matches: (d) =>
      d.ours === 'allow' && d.ubol === 'block' && ['main_frame', 'sub_frame'].every((t) => d.ourRule?.condition.resourceTypes?.includes(t) === true),
  },
  {
    id: 'follow-up-badfilter-case',
    explanation:
      'Compiler gap: a cross-list `$badfilter` cancels only an exact-case match; uBO compares filters case-insensitively (`||bing.com/rewardsapp/reportactivity?$badfilter` cancels EasyPrivacy\'s `reportActivity?`). Follow-up for compiler/normalise.',
    excludedFromGate: false,
    ceiling: 0,
    matches: (d) => d.ours === 'block' && passes(d.ubol) && /[A-Z]/.test(d.ourRule?.condition.urlFilter ?? ''),
  },
];

/** The first class that explains `d`, or `null`. */
export function classify(d: Difference): DifferenceClass | null {
  return DIFFERENCE_CLASSES.find((c) => c.matches(d)) ?? null;
}
