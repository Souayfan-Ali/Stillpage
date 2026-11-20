/**
 * Stage 3 (filter-pipeline notes §2): network entries of one ruleset → converter-dialect filter lines plus a
 * reason-coded log. Pop-up filters are set aside for the pop-up emitter (§7a); everything that is
 * not a network filter passes through unchanged for the cosmetic and scriptlet emitters.
 */
import { RawRuleConverter, type NetworkRule } from '@adguard/agtree';
import type { Entry, FilterSource } from '../parse/parse-list.js';
import { isBadfilter, isBadfiltered, type BadfilterSet } from './badfilter.js';
import { findMod, generate, modsOf, nameOf, valueOf, withMods, withoutMods } from './modifiers.js';
import type { FixCode, ReasonCode } from './reasons.js';
import { isRejected, looksLikeHost, runSteps, type NetFilter, type TopDomains } from './transforms.js';

export interface LogEntry {
  readonly source: FilterSource;
  readonly reason: ReasonCode;
  readonly detail?: string;
}

/** One line for the converter, with the source filter and the patches to apply to its rules. */
export interface ConverterInput {
  readonly text: string;
  readonly source: FilterSource;
  readonly fixes: readonly FixCode[];
  readonly top?: TopDomains;
  readonly docTypes?: 'only' | 'add';
  readonly uritransform?: string;
}

export interface NormalisedRuleset {
  readonly inputs: readonly ConverterInput[];
  /** `$popup` / `$popunder` filters for the pop-up emitter (filter-pipeline notes §7a). */
  readonly popups: readonly Entry[];
  /** Cosmetic, scriptlet and cosmetic-switch entries, untouched. */
  readonly rest: readonly Entry[];
  readonly log: readonly LogEntry[];
}

type Outcome = { readonly inputs: readonly ConverterInput[] } | { readonly log: LogEntry };

const POPUP = new Set(['popup', 'popunder']);
const TYPES = new Set(['script', 'image', 'stylesheet', 'css', 'object', 'xmlhttprequest', 'xhr', 'subdocument', 'frame',
  'ping', 'beacon', 'websocket', 'media', 'font', 'other', 'doc', 'document', 'webtransport', 'webbundle']);

function toConverter(f: NetFilter, source: FilterSource): Outcome {
  try {
    const { result } = RawRuleConverter.convertToAdg(generate(f.node));
    const extras = { ...(f.top && { top: f.top }), ...(f.docTypes && { docTypes: f.docTypes }),
      ...(f.uritransform !== undefined && { uritransform: f.uritransform }) };
    return { inputs: result.map((text) => ({ text, source, fixes: f.fixes, ...extras })) };
  } catch (e) {
    return { log: { source, reason: 'agtree-convert', detail: e instanceof Error ? e.message : String(e) } };
  }
}

/**
 * uBO's `$redirect=` is a block plus a redirect-only-if-blocked (P1-22): the block half goes to the
 * safe ruleset, so disabling the `-x` ruleset never unblocks the request (S-19). ABP's `rewrite=` is a
 * synonym in uBO (`static-filtering-parser.js`). Exceptions and `redirect=none` carry no block.
 */
function redirectCompanion(f: NetFilter): NetFilter | undefined {
  const redirect = findMod(f.node, 'redirect') ?? findMod(f.node, 'rewrite');
  if (f.node.exception || redirect === undefined || redirect.exception === true || valueOf(redirect) === 'none') return undefined;
  return { ...f, node: withoutMods(f.node, 'redirect', 'rewrite'), fixes: [...f.fixes, 'redirect-implies-block'] };
}

/** Normalises one parsed network rule (`fixes` already applied by the caller are kept). */
export function normaliseNetwork(node: NetworkRule, source: FilterSource, fixes: readonly FixCode[] = []): Outcome {
  const r = runSteps({ node, fixes });
  if (isRejected(r)) return { log: { source, reason: r.reject, ...(r.detail !== undefined && { detail: r.detail }) } };
  const companion = redirectCompanion(r);
  const main = toConverter(r, source);
  if (companion === undefined || !('inputs' in main)) return main;
  const block = toConverter(companion, source);
  return 'inputs' in block ? { inputs: [...main.inputs, ...block.inputs] } : main;
}

/** For `…$popup,<types>` the same filter without `popup` (uBO applies it to those types too); else undefined. */
export function withoutPopup(node: NetworkRule): NetworkRule | undefined {
  const mods = modsOf(node);
  if (!mods.some((m) => TYPES.has(nameOf(m)) && m.exception !== true)) return undefined;
  return withMods(node, mods.filter((m) => !POPUP.has(nameOf(m))));
}

const hostOutcome = (e: Entry): Outcome => {
  if (e.node?.category !== 'Network' || e.node.type !== 'HostRule') return { inputs: [] };
  const hosts = e.node.hostnames.children.map((h) => h.value);
  // A bare adblock line that is not a host (`_chartbeat.js`) is a URL substring in uBO (P1-45 gap 1).
  const [only] = hosts;
  if (hosts.length === 1 && only !== undefined && e.source.text === only && !looksLikeHost(only)) {
    return { inputs: [{ text: `*${only}`, source: e.source, fixes: ['bare-substring'] }] };
  }
  return { inputs: hosts.map((h) => ({ text: `||${h}^`, source: e.source, fixes: ['hosts-line'] })) };
};

function networkOutcome(e: Entry): Outcome {
  if (e.node?.category !== 'Network' || e.node.type !== 'NetworkRule') return { inputs: [] };
  if (e.kind === 'network') return normaliseNetwork(e.node, e.source);
  const rest = withoutPopup(e.node);
  return rest ? normaliseNetwork(rest, e.source, ['popup-also-network']) : { inputs: [] };
}

function outcomeOf(e: Entry, bad: BadfilterSet): Outcome | undefined {
  if (e.kind === 'invalid') return { log: { source: e.source, reason: 'invalid-syntax', ...(e.detail !== undefined && { detail: e.detail }) } };
  if (e.kind === 'network.host') return hostOutcome(e);
  if (e.kind !== 'network' && e.kind !== 'network.popup') return undefined;
  if (isBadfilter(e)) return { inputs: [] };
  if (isBadfiltered(e, bad)) return { log: { source: e.source, reason: 'badfilter' } };
  return networkOutcome(e);
}

/** Normalises the entries of one ruleset; `bad` comes from `collectBadfilters` over the whole build. */
export function normaliseRuleset(entries: readonly Entry[], bad: BadfilterSet): NormalisedRuleset {
  const inputs: ConverterInput[] = [];
  const log: LogEntry[] = [];
  const popups: Entry[] = [];
  const rest: Entry[] = [];
  for (const e of entries) {
    if (e.kind === 'network.popup' && !isBadfilter(e) && !isBadfiltered(e, bad)) popups.push(e);
    const outcome = outcomeOf(e, bad);
    if (outcome === undefined) rest.push(e);
    else if ('log' in outcome) log.push(outcome.log);
    else inputs.push(...outcome.inputs);
  }
  return { inputs, popups, rest, log };
}
