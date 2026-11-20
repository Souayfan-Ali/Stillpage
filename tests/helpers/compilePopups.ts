/**
 * `$popup` filter lines → the `popups` ruleset and its destination list, through the compiler's own
 * pop-up emitter (P1-49/P1-50), for test builds whose fixtures name the filters they exercise (P2-61).
 * No entity map, one test list. Vitest-free, so the Playwright helpers can use it too.
 */
import type { DnrRule } from '../../compiler/dnr/schema.js';
import { classify } from '../../compiler/parse/classify.js';
import { buildPopups } from '../../compiler/popups/emit.js';

export interface CompiledPopups {
  /** Plain rules, numbered from 1. */
  readonly rules: readonly DnrRule[];
  /** Pruned, sorted hosts of the plain `||host^$popup` blocks (exceptions included, as the build does). */
  readonly destinations: readonly string[];
}

export function compilePopups(lines: readonly string[]): Promise<CompiledPopups> {
  const entries = lines.map((text, i) => ({ ...classify(text), source: { list: 'l', line: i + 1, text }, trusted: true }));
  const built = buildPopups(entries, new Map(), () => undefined);
  return Promise.resolve({ rules: built.rules.map((b, i) => ({ ...b.rule, id: i + 1 })), destinations: built.destinations });
}
