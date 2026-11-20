/**
 * Post-convert patches for what the converter cannot express (filter-pipeline notes §4): uBO `top=` →
 * `topDomains`, `$removeparam,doc` → `main_frame`, `uritransform=` → `regexSubstitution`. A patch
 * applies only when every source filter of the rule asks for the same patch; otherwise the rule is
 * reported as a conflict and left unpatched.
 */
import { RESOURCE_TYPES, type DnrRule } from '../dnr/schema.js';
import type { ConverterInput } from '../normalise/normalise.js';

type PatchKey = 'top' | 'docTypes' | 'uritransform';

/** The common value of `key` over `sources`; `conflict` when only some (or different values) carry it. */
function agreed<K extends PatchKey>(sources: readonly ConverterInput[], key: K): ConverterInput[K] | 'conflict' | undefined {
  const values = sources.map((s) => (s[key] === undefined ? undefined : JSON.stringify(s[key])));
  const first = values[0];
  if (values.every((v) => v === undefined)) return undefined;
  if (first === undefined || values.some((v) => v !== first)) return 'conflict';
  return sources[0]?.[key];
}

function patchTop(rule: DnrRule, top: NonNullable<ConverterInput['top']>): DnrRule {
  const condition = {
    ...rule.condition,
    ...(top.include.length > 0 && { topDomains: [...top.include].sort() }),
    ...(top.exclude.length > 0 && { excludedTopDomains: [...top.exclude].sort() }),
  };
  return { ...rule, condition };
}

function patchDocTypes(rule: DnrRule, mode: 'only' | 'add'): DnrRule {
  // `add` on a rule with no type list keeps the converter's default (all but main_frame) and adds main_frame.
  if (mode === 'add' && rule.condition.resourceTypes === undefined) {
    const excluded = new Set(rule.condition.excludedResourceTypes ?? []);
    return { ...rule, condition: { ...rule.condition, resourceTypes: RESOURCE_TYPES.filter((t) => !excluded.has(t)) } };
  }
  const types = mode === 'only' ? ['main_frame' as const] : [...new Set([...(rule.condition.resourceTypes ?? []), 'main_frame' as const])];
  return { ...rule, condition: { ...rule.condition, resourceTypes: types } };
}

const patchUritransform = (rule: DnrRule, regexSubstitution: string): DnrRule => rule.action.type !== 'block' ? rule :
  ({ ...rule, action: { type: 'redirect', redirect: { regexSubstitution } } });

export interface PatchResult {
  readonly rule: DnrRule;
  readonly conflicts: readonly PatchKey[];
}

/** Applies the patches its sources agree on. Pure. */
export function applyPatches(rule: DnrRule, sources: readonly ConverterInput[]): PatchResult {
  const top = agreed(sources, 'top');
  const doc = agreed(sources, 'docTypes');
  const uri = agreed(sources, 'uritransform');
  let out = rule;
  if (top !== undefined && top !== 'conflict') out = patchTop(out, top);
  if (doc !== undefined && doc !== 'conflict') out = patchDocTypes(out, doc);
  if (uri !== undefined && uri !== 'conflict' && out.condition.regexFilter !== undefined) out = patchUritransform(out, uri);
  const conflicts = ([['top', top], ['docTypes', doc], ['uritransform', uri]] as const)
    .filter(([, v]) => v === 'conflict')
    .map(([k]) => k);
  return { rule: out, conflicts };
}
