/**
 * Branded identifiers (P1-01). A brand is only ever attached by a parser that checked the value,
 * so a `RulesetId` or `PackId` in a signature means "already validated".
 * `Hostname` is attached by `core/hostname/validate.ts`.
 */
import { MAX_ID_LENGTH } from './limits.js';

declare const brand: unique symbol;

/** A nominal type: `T` tagged with `B`, assignable only through a validating parser. */
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A lower-case ASCII hostname without a trailing dot, validated by `parseHostname`. */
export type Hostname = Brand<string, 'Hostname'>;
/** A DNR ruleset id as declared in the manifest and the catalog (`ubo`, `ubo-x`, `reg-de`). */
export type RulesetId = Brand<string, 'RulesetId'>;
/** A user-facing pack id from the catalog (`ads`, `annoy-social`). */
export type PackId = Brand<string, 'PackId'>;

/**
 * Lower-case words joined by single hyphens, starting with a letter: never `_` (reserved by Chrome)
 * and never integer-like (JS orders integer keys first, which would reorder catalog packs).
 */
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Suffix of every unsafe (`redirect` / `modifyHeaders`) ruleset. */
const UNSAFE_SUFFIX = '-x';

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

/** Returns `value` as a `RulesetId`, or `null` if it is not a valid ruleset id. */
export function parseRulesetId(value: unknown): RulesetId | null {
  return isId(value) ? (value as RulesetId) : null;
}

/** Returns `value` as a `PackId`, or `null` if it is not a valid pack id. */
export function parsePackId(value: unknown): PackId | null {
  return isId(value) ? (value as PackId) : null;
}

/** True for `-x` rulesets: the ones holding rules that need host access (ADR-007, D-06). */
export function isUnsafeRulesetId(id: RulesetId): boolean {
  return id.endsWith(UNSAFE_SUFFIX);
}
