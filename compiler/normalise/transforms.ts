/**
 * The uBO-dialect normaliser (filter-pipeline notes §4, ADR-004 condition 3): each step copies what uBOL does in
 * `static-net-filtering.js` / `static-dnr-filtering.js` (gorhill/uBlock 2bc679d9) and is a pure
 * function. One golden test per transform: `tests/golden/compiler/normalise.json`.
 */
import { ModifierListParser, type NetworkRule } from '@adguard/agtree';
import type { FixCode, ReasonCode } from './reasons.js';
import {
  findMod, generate, hasMod, isRegexPattern, modsOf, nameOf, renamed, splitPipe, valueOf, withMods, withoutMods, withPattern,
  type Mod,
} from './modifiers.js';

/** `top=` of uBO, applied after conversion as DNR `topDomains` / `excludedTopDomains` (the converter has none). */
export interface TopDomains {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** A network filter on its way to the converter, with what the post-convert patches need to know. */
export interface NetFilter {
  readonly node: NetworkRule;
  readonly fixes: readonly FixCode[];
  readonly top?: TopDomains;
  /** `$removeparam,doc`: `main_frame` is the only type (`only`) or is added to the others (`add`). */
  readonly docTypes?: 'only' | 'add';
  /** `uritransform=//repl/` on a regex filter: DNR `regexSubstitution` (`\1`-style groups). */
  readonly uritransform?: string;
}

export interface Rejected {
  readonly reject: ReasonCode;
  readonly detail?: string;
}

export type StepResult = NetFilter | Rejected;
export type Step = (f: NetFilter) => StepResult;

export const isRejected = (r: StepResult): r is Rejected => 'reject' in r;

const fixed = (f: NetFilter, node: NetworkRule, fix: FixCode, extra: Partial<NetFilter> = {}): NetFilter =>
  ({ ...f, ...extra, node, fixes: [...f.fixes, fix] });

const OPTION_NAME = /^~?[a-z0-9_-]+$/i;
const OPTION_START = /^~?[a-z0-9_-]+(?:=|,|$)/i;

/** uBO's `indexOfNetAnchor`: the last `$` followed by something that reads as an option. */
function optionAnchor(text: string): number {
  for (let j = text.lastIndexOf('$'); j !== -1; j = j === 0 ? -1 : text.lastIndexOf('$', j - 1)) {
    if (OPTION_START.test(text.slice(j + 1))) return j;
  }
  return -1;
}

/**
 * agtree splits options at the last `$`, so a `$` inside an option value (`uritransform=//$1$2/`)
 * yields a bogus option name. Re-split where uBO would.
 */
export const optionAnchorFix: Step = (f) => {
  if (modsOf(f.node).every((m) => OPTION_NAME.test(nameOf(m)))) return f;
  const body = generate(f.node).replace(/^@@/, '');
  const j = optionAnchor(body);
  if (j <= 0) return f;
  try {
    const options = ModifierListParser.parse(body.slice(j + 1), { tolerant: false, isLocIncluded: false });
    return fixed(f, withMods(withPattern(f.node, body.slice(0, j)), options.children), 'option-anchor');
  } catch {
    return f; // not a valid option list either: leave it to the converter, which logs it
  }
};

const BARE_HOST = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;

/** A last label that is a file extension, not a TLD: `ads.js` is a path substring, not a host. */
const FILE_EXTENSIONS = new Set(['js', 'css', 'png', 'gif', 'jpg', 'jpeg', 'webp', 'svg', 'ico', 'html', 'htm', 'php',
  'json', 'xml', 'txt', 'mp4', 'webm', 'm3u8', 'swf', 'aspx', 'jsp', 'cgi', 'woff', 'woff2', 'ttf', 'wasm', 'map']);
export const looksLikeHost = (p: string): boolean => BARE_HOST.test(p) && !FILE_EXTENSIONS.has(p.slice(p.lastIndexOf('.') + 1));

/** uBO treats a bare hostname pattern (`img.example.com$image`) as `||img.example.com^`. */
const bareHostname: Step = (f) =>
  looksLikeHost(f.node.pattern.value) ? fixed(f, withPattern(f.node, `||${f.node.pattern.value}^`), 'bare-hostname') : f;

const BARE_TOKEN = /^[a-z0-9_.-]*\.[a-z0-9_.-]*$/i;

/**
 * An option-less bare pattern that is not a host (`_chartbeat.js`) is a URL substring in uBO; the
 * converter would read it as a hosts-file line and anchor it (`||_chartbeat.js^`, P1-45 gap 1). A
 * leading `*` keeps it a substring.
 */
const bareSubstring: Step = (f) => {
  const p = f.node.pattern.value;
  if (modsOf(f.node).length > 0 || !BARE_TOKEN.test(p) || looksLikeHost(p)) return f;
  return fixed(f, withPattern(f.node, `*${p}`), 'bare-substring');
};

/** Cosmetic switches carry no network meaning; on a network filter the converter would widen it to frames (P1-45 gap 3). */
const COSMETIC_OPTIONS = new Set(['elemhide', 'ehide', 'generichide', 'ghide', 'specifichide', 'shide']);

const dropCosmeticOptions: Step = (f) => {
  const mods = modsOf(f.node);
  if (!mods.some((m) => COSMETIC_OPTIONS.has(nameOf(m)))) return f;
  return fixed(f, withMods(f.node, mods.filter((m) => !COSMETIC_OPTIONS.has(nameOf(m)))), 'drop-cosmetic-options');
};

/** Options uBOL cannot express in DNR either: rejected with their own reason. */
const UBO_ONLY: ReadonlyMap<string, ReasonCode> = new Map([
  ['redirect-rule', 'ubo-redirect-rule'], ['urlskip', 'ubo-urlskip'], ['strict1p', 'ubo-strict-party'],
  ['strict3p', 'ubo-strict-party'], ['ipaddress', 'ubo-ipaddress'], ['cname', 'ubo-cname'], ['replace', 'ubo-replace'],
  ['requestheader', 'ubo-requestheader'],
]);
const REGEX_VALUE = /^~?\/.+\/[a-z]*$/;

const rejectUboOnly: Step = (f) => {
  for (const m of modsOf(f.node)) {
    const reason = UBO_ONLY.get(nameOf(m));
    if (reason) return { reject: reason, detail: nameOf(m) };
    if (nameOf(m) === 'removeparam' && REGEX_VALUE.test(valueOf(m) ?? '')) return { reject: 'ubo-regex-removeparam' };
    if (nameOf(m) === 'header' && /^[^:]+:\//.test(valueOf(m) ?? '')) return { reject: 'ubo-regex-header' };
  }
  return f;
};

/** `from=` is uBO's name for `domain=`; both lists merge if a filter has both. */
const fromToDomain: Step = (f) => {
  const from = findMod(f.node, 'from');
  if (!from) return f;
  const domain = findMod(f.node, 'domain');
  const value = [domain && valueOf(domain), valueOf(from)].filter((v) => v !== undefined).join('|');
  const kept = modsOf(f.node).filter((m) => m !== from && m !== domain);
  return fixed(f, withMods(f.node, [...kept, renamed(from, 'domain', value)]), 'from-to-domain');
};

/** `reason=` only annotates the uBO block page. */
const dropReason: Step = (f) => (findMod(f.node, 'reason') ? fixed(f, withoutMods(f.node, 'reason'), 'drop-reason') : f);

/** Entity hostnames (`example.*`) are dropped from `domain=` as uBOL does; no positive plain domain left → rejected. */
const entityDomains: Step = (f) => {
  const domain = findMod(f.node, 'domain');
  if (!domain) return f;
  const entries = splitPipe(valueOf(domain));
  if (entries.some((d) => d.replace(/^~/, '').startsWith('/'))) return { reject: 'ubo-regex-domain' };
  if (!entries.some((d) => d.endsWith('.*'))) return f;
  const kept = entries.filter((d) => !d.endsWith('.*'));
  const hadPositive = entries.some((d) => !d.startsWith('~'));
  if (hadPositive && !kept.some((d) => !d.startsWith('~'))) return { reject: 'ubo-entity-domain-only' };
  const others = modsOf(f.node).filter((m) => m !== domain);
  const mods: readonly Mod[] = kept.length === 0 ? others : [...others, renamed(domain, 'domain', kept.join('|'))];
  return fixed(f, withMods(f.node, mods), 'drop-entity-domains');
};

/** `top=` (frame-tree top domain) → DNR `topDomains`, set after conversion. */
const topDomains: Step = (f) => {
  const top = findMod(f.node, 'top');
  if (!top) return f;
  const entries = splitPipe(valueOf(top));
  const include = entries.filter((d) => !d.startsWith('~'));
  const exclude = entries.filter((d) => d.startsWith('~')).map((d) => d.slice(1));
  return fixed(f, withoutMods(f.node, 'top'), 'top-to-topdomains', { top: { include, exclude } });
};

const TYPE_NAMES = new Set(['script', 'image', 'stylesheet', 'css', 'object', 'xmlhttprequest', 'xhr', 'subdocument', 'frame',
  'ping', 'beacon', 'websocket', 'media', 'font', 'other', 'webtransport', 'webbundle']);
const DOC = ['doc', 'document'];

/** `$removeparam,doc`: the converter refuses `$document`; uBOL compiles it for `main_frame`. */
const removeparamDoc: Step = (f) => {
  if (!findMod(f.node, 'removeparam') || !hasMod(f.node, ...DOC)) return f;
  const node = withoutMods(f.node, ...DOC);
  const hasOtherTypes = modsOf(node).some((m) => TYPE_NAMES.has(nameOf(m)) && m.exception !== true);
  return fixed(f, node, 'removeparam-doc', { docTypes: hasOtherTypes ? 'add' : 'only' });
};

/** Splits `/pattern/replacement/flags` on unescaped slashes; undefined when malformed. */
function splitReplace(value: string): { pattern: string; replacement: string } | undefined {
  if (!value.startsWith('/')) return undefined;
  const parts = value.slice(1).split(/(?<!\\)\//);
  const [pattern, replacement] = parts;
  if (pattern === undefined || replacement === undefined || parts.length < 3) return undefined;
  return { pattern, replacement };
}

/**
 * `uritransform=`: uBOL converts only the empty-pattern form on a regex filter into a
 * `regexSubstitution` redirect (`$1` → `\1`); everything else uBOL rejects as well.
 */
const uritransform: Step = (f) => {
  const m = findMod(f.node, 'uritransform');
  if (!m) return f;
  const parsed = splitReplace(valueOf(m) ?? '');
  if (f.node.exception || parsed?.pattern !== '' || !isRegexPattern(f.node.pattern.value)) {
    return { reject: 'ubo-uritransform-incompatible', detail: valueOf(m) ?? '' };
  }
  const substitution = parsed.replacement.replace(/\$(\d)/g, '\\$1');
  return fixed(f, withoutMods(f.node, 'uritransform'), 'uritransform', { uritransform: substitution });
};

/** The steps in order: re-anchor first, then `rejectUboOnly`, so nothing else touches a filter that cannot ship. */
const STEPS: readonly Step[] = [optionAnchorFix, rejectUboOnly, bareHostname, bareSubstring, dropCosmeticOptions, fromToDomain, dropReason, entityDomains, topDomains,
  removeparamDoc, uritransform];

/** Runs every step; stops at the first rejection. */
export function runSteps(start: NetFilter, steps: readonly Step[] = STEPS): StepResult {
  let current: StepResult = start;
  for (const step of steps) {
    if (isRejected(current)) return current;
    current = step(current);
  }
  return current;
}
