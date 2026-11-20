/** Typed result for expected failures (tooling notes §4): exceptions are for bugs only. */
export type Result<T, E = readonly string[]> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: E };

/** Wraps a success value. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Wraps a list of error messages. */
export function err(errors: readonly string[]): Result<never> {
  return { ok: false, errors };
}
