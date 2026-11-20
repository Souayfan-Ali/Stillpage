/**
 * Stage 2 (filter-pipeline notes §4): parse a line with agtree and classify it. The AST is returned for the later
 * stages and must be treated as read-only (the normaliser works on its own parse).
 */
import { defaultParserOptions, RuleParser, type AnyRule } from '@adguard/agtree';

/** Every class a filter line can fall in. Golden tests: `tests/golden/classify.json`. */
export const LINE_KINDS = [
  'comment',
  'invalid',
  'network',
  'network.host',
  'network.popup',
  'network.cosmetic-switch',
  'cosmetic.specific',
  'cosmetic.generic',
  'cosmetic.procedural',
  'cosmetic.exception',
  'scriptlet',
  'scriptlet.exception',
  'html-filter',
  'unsupported',
] as const;

export type LineKind = (typeof LINE_KINDS)[number];

export interface Classified {
  readonly kind: LineKind;
  /** agtree's AST; absent for comments. Read-only by convention. */
  readonly node?: AnyRule;
  /** Why a line is `unsupported` or `invalid`. */
  readonly detail?: string;
}

const PARSER_OPTIONS = Object.freeze({ ...defaultParserOptions, tolerant: true, isLocIncluded: false, parseHostRules: true, includeRaws: false });

const POPUP_MODIFIERS = new Set(['popup', 'popunder']);
/** Network-syntax exceptions that only switch cosmetic or scriptlet filtering off (handled with cosmetic data, not DNR). */
const COSMETIC_SWITCHES = new Set(['elemhide', 'ehide', 'generichide', 'ghide', 'specifichide', 'shide', 'jsinject',
  'content', 'extension', 'urlblock', 'stealth', 'genericblock']);
/** Options that may accompany a cosmetic switch without making it a network rule. */
const SWITCH_COMPANIONS = new Set(['domain', 'from']);
/**
 * Selector operators that need JavaScript (uBO's procedural engine). Native CSS `:has()`, `:is()`,
 * `:not()` stay plain CSS (uBOL env has `native_css_has`). Same set as the S-03 audit.
 */
const PROCEDURAL_OPERATORS = ['has-text', 'contains', '-abp-contains', 'upward', 'xpath', 'watch-attr', 'watch-attrs',
  'min-text-length', 'matches-css', 'matches-css-before', 'matches-css-after', 'matches-attr', 'matches-path',
  'matches-prop', 'matches-media', 'others', 'remove', 'remove-attr', 'remove-class', 'style', 'nth-ancestor', 'if',
  'if-not', 'shadow', '-abp-has'];
const PROCEDURAL_RE = new RegExp(`:(?:${PROCEDURAL_OPERATORS.map((o) => o.replace(/-/g, '\\-')).join('|')})\\(`);

/** Parses one line with agtree in tolerant mode (invalid lines become `InvalidRule` nodes). */
export function parseLine(text: string): AnyRule {
  return RuleParser.parse(text, PARSER_OPTIONS);
}

function isCommentText(t: string): boolean {
  if (t === '' || t.startsWith('!')) return true;
  if (t.startsWith('[') && t.endsWith(']')) return true;
  return t.startsWith('#') && !/^#[@?$%]?#/.test(t);
}

function modifierNames(node: AnyRule): readonly string[] {
  if (node.category !== 'Network' || node.type !== 'NetworkRule') return [];
  return (node.modifiers?.children ?? []).map((m) => m.name.value);
}

function classifyNetwork(node: AnyRule): LineKind {
  if (node.type === 'HostRule') return 'network.host';
  const mods = modifierNames(node);
  if (mods.some((m) => POPUP_MODIFIERS.has(m))) return 'network.popup';
  const isException = node.category === 'Network' && node.exception;
  const isSwitch = isException && mods.some((m) => COSMETIC_SWITCHES.has(m))
    && mods.every((m) => COSMETIC_SWITCHES.has(m) || SWITCH_COMPANIONS.has(m));
  return isSwitch ? 'network.cosmetic-switch' : 'network';
}

/** True when an element-hiding or CSS-injection rule needs uBO's procedural engine. */
function isProcedural(node: AnyRule): boolean {
  if (node.category !== 'Cosmetic' || (node.type !== 'ElementHidingRule' && node.type !== 'CssInjectionRule')) return false;
  // `:remove()` is an action that needs JS; a plain `:style()` stays declarative CSS (sanitised later).
  const removes = node.type === 'CssInjectionRule' && node.body.remove === true;
  return removes || node.separator.value.includes('?') || PROCEDURAL_RE.test(node.body.selectorList.value) || node.modifiers !== undefined;
}

const hasPositiveDomain = (node: AnyRule): boolean =>
  node.category === 'Cosmetic' && node.domains.children.some((d) => !d.exception);

function classifyCosmetic(node: AnyRule): Classified {
  if (node.category !== 'Cosmetic') return { kind: 'unsupported', node };
  switch (node.type) {
    case 'ScriptletInjectionRule':
      // uBO also accepts AdGuard's `#%#//scriptlet(…)` form; ABP snippets have no uBO counterpart.
      if (node.syntax === 'AdblockPlus') return { kind: 'unsupported', node, detail: `scriptlet syntax ${node.syntax}` };
      return { kind: node.exception ? 'scriptlet.exception' : 'scriptlet', node };
    case 'HtmlFilteringRule':
      return { kind: 'html-filter', node };
    case 'ElementHidingRule':
    case 'CssInjectionRule': {
      if (node.syntax === 'AdGuard') return { kind: 'unsupported', node, detail: `cosmetic syntax ${node.syntax}` };
      if (node.exception) return { kind: 'cosmetic.exception', node };
      if (isProcedural(node)) return { kind: 'cosmetic.procedural', node };
      return { kind: hasPositiveDomain(node) ? 'cosmetic.specific' : 'cosmetic.generic', node };
    }
    default:
      return { kind: 'unsupported', node, detail: node.type };
  }
}

/** Classifies one (already preparsed) line of an `adblock`-format list. */
export function classify(text: string): Classified {
  const t = text.trim();
  if (isCommentText(t)) return { kind: 'comment' };
  const node = parseLine(t);
  if (node.category === 'Comment' || node.category === 'Empty') return { kind: 'comment' };
  if (node.category === 'Invalid') return { kind: 'invalid', node, detail: node.error.message };
  if (node.category === 'Cosmetic') return classifyCosmetic(node);
  return { kind: classifyNetwork(node), node };
}
