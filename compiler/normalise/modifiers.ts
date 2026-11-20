/**
 * Immutable helpers over agtree's network-rule AST: every change returns a new node and leaves the
 * parsed input untouched (agtree's nodes are plain mutable objects; we never write to them).
 */
import { RuleGenerator, type Modifier, type NetworkRule } from '@adguard/agtree';

export type Mod = Readonly<Modifier>;

/** The modifiers of `node` (empty when it has none). */
export const modsOf = (node: NetworkRule): readonly Mod[] => node.modifiers?.children ?? [];

export const nameOf = (m: Mod): string => m.name.value;
export const valueOf = (m: Mod): string | undefined => m.value?.value;

/** True when a modifier with one of `names` is present and not negated (`~doc` is negation). */
export const hasMod = (node: NetworkRule, ...names: readonly string[]): boolean =>
  modsOf(node).some((m) => names.includes(nameOf(m)) && m.exception !== true);

export const findMod = (node: NetworkRule, name: string): Mod | undefined => modsOf(node).find((m) => nameOf(m) === name);

/** `node` with `children` as its modifier list (no list at all when empty). */
export function withMods(node: NetworkRule, children: readonly Mod[]): NetworkRule {
  if (children.length === 0) {
    const copy: NetworkRule = { ...node };
    delete copy.modifiers; // a fresh local copy, not the input
    return copy;
  }
  return { ...node, modifiers: { type: 'ModifierList', children: children.map((m) => ({ ...m })) } };
}

/** `node` without the modifiers named in `names`. */
export const withoutMods = (node: NetworkRule, ...names: readonly string[]): NetworkRule =>
  withMods(node, modsOf(node).filter((m) => !names.includes(nameOf(m))));

/** A copy of `m` with a new name and/or value. */
export function renamed(m: Mod, name: string, value?: string): Mod {
  const base: Modifier = { ...m, name: { ...m.name, value: name } };
  if (value === undefined) return base;
  return { ...base, value: { type: 'Value', value } };
}

export const withPattern = (node: NetworkRule, value: string): NetworkRule => ({ ...node, pattern: { ...node.pattern, value } });

/** Pipe-separated modifier value → entries (`a.com|~b.com`). */
export const splitPipe = (value: string | undefined): readonly string[] =>
  (value ?? '').split('|').map((d) => d.trim()).filter((d) => d !== '');

/** True when a filter pattern is a regex literal (`/…/`). */
export const isRegexPattern = (pattern: string): boolean => pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/');

/** uBO filter text for `node`. */
export const generate = (node: NetworkRule): string => RuleGenerator.generate(node);
