/**
 * Stage 4 (filter-pipeline notes §2): converter-dialect lines of one ruleset → DNR rules with a source map, using
 * `@adguard/dnr-converter` 2.1.0 (build time only). All lines are converted as one combined filter.
 * `$csp` filters go through the converter's CSP pass, which resolves `@@…$csp` exceptions against
 * the `$csp` filters at build time (S-02a); what it cannot resolve is logged.
 */
import { Filter, FilterConverter, type IRulesetWithSourceMap } from '@adguard/dnr-converter';
import { DnrRuleSchema, type DnrRule } from '../dnr/schema.js';
import type { ConverterInput, LogEntry } from '../normalise/normalise.js';
import { reasonOfConverterError } from './errors.js';
import { applyPatches } from './patches.js';
import { withAcceptAllRegex } from './regex-gate.js';

/** Where redirect resources live in the package; P1-30 maps names onto our surrogates. */
const RESOURCES_PATH = '/surrogates';
const FILTER_ID = 1;
const CSP_OPTION = /[$,]csp(?:[=,]|$)/;

export interface ConvertedRule {
  /** Converter output; `id` is the converter's, replaced by the ledger id in P1-24. */
  readonly rule: DnrRule;
  readonly sources: readonly ConverterInput[];
}

export interface ConvertResult {
  readonly rules: readonly ConvertedRule[];
  readonly log: readonly LogEntry[];
  /** Every regex the converter emitted, for the Chromium gate (P1-23). */
  readonly regexes: readonly string[];
}

interface RawError {
  readonly name?: string;
  readonly message: string;
  readonly offset?: number;
  readonly rule?: { readonly index?: number };
}

/** Maps a character offset in the combined text back to its input. */
function locator(inputs: readonly ConverterInput[]): (offset: number) => ConverterInput | undefined {
  const starts: number[] = [];
  let pos = 0;
  for (const input of inputs) {
    starts.push(pos);
    pos += input.text.length + 1;
  }
  return (offset) => {
    if (offset < 0 || offset >= pos) return undefined;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return inputs[lo];
  };
}

async function collect(ruleset: IRulesetWithSourceMap, errors: readonly unknown[], inputs: readonly ConverterInput[]): Promise<{ rules: ConvertedRule[]; log: LogEntry[] }> {
  const at = locator(inputs);
  const rules: ConvertedRule[] = [];
  for (const raw of await ruleset.getDeclarativeRules()) {
    const indexes = await ruleset.getSourceRuleIndexes(raw.id);
    const sources = indexes.map((i) => at(i.sourceRuleIndex)).filter((s): s is ConverterInput => s !== undefined);
    rules.push({ rule: DnrRuleSchema.parse(raw), sources });
  }
  const log = (errors as readonly RawError[]).map((e): LogEntry => {
    const input = at(e.offset ?? e.rule?.index ?? -1);
    if (!input) throw new Error(`converter error without a source: ${e.message}`);
    return { source: input.source, reason: reasonOfConverterError(e), detail: e.message };
  });
  return { rules, log };
}

async function convertPass(inputs: readonly ConverterInput[], csp: boolean): Promise<{ rules: ConvertedRule[]; log: LogEntry[] }> {
  if (inputs.length === 0) return { rules: [], log: [] };
  const filter = new Filter(FILTER_ID, inputs.map((i) => i.text).join('\n'));
  const converter = new FilterConverter();
  if (csp) {
    const r = await converter.convertCspRules([filter], RESOURCES_PATH);
    return collect(r.ruleset, r.errors, inputs);
  }
  const [r] = await converter.convert([filter], { withSourceMap: true, combine: true, resourcesPath: RESOURCES_PATH });
  if (!r) throw new Error('converter returned no ruleset');
  return collect(r.ruleset, r.errors, inputs);
}

function patched(converted: readonly ConvertedRule[]): { rules: ConvertedRule[]; log: LogEntry[] } {
  const log: LogEntry[] = [];
  const rules = converted.map((c) => {
    const { rule, conflicts } = applyPatches(c.rule, c.sources);
    for (const key of conflicts) {
      for (const s of c.sources.filter((x) => x[key] !== undefined)) log.push({ source: s.source, reason: 'patch-conflict', detail: key });
    }
    return { rule, sources: c.sources };
  });
  return { rules, log };
}

/** Converts one ruleset's inputs. Deterministic for equal inputs. */
export async function convertRuleset(inputs: readonly ConverterInput[]): Promise<ConvertResult> {
  const cspInputs = inputs.filter((i) => CSP_OPTION.test(i.text));
  const plainInputs = inputs.filter((i) => !CSP_OPTION.test(i.text));
  const { value, regexes } = await withAcceptAllRegex(async () => {
    const plain = await convertPass(plainInputs, false);
    const csp = await convertPass(cspInputs, true);
    return { plain, csp };
  });
  const p = patched([...value.plain.rules, ...value.csp.rules]);
  return { rules: p.rules, log: [...value.plain.log, ...value.csp.log, ...p.log], regexes };
}

/** Debug artefact (filter-pipeline notes §10, not shipped): rule index → the source filters it came from. */
export function sourceMapOf(rules: readonly ConvertedRule[]): readonly (readonly { list: string; line: number; text: string }[])[] {
  return rules.map((r) => r.sources.map((s) => ({ list: s.source.list, line: s.source.line, text: s.source.text })));
}
