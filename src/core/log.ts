/** Logger interface (tooling notes §4: no `console.*`; a tiny logger compiled out of release builds). */
export interface Logger {
  readonly warn: (message: string, detail?: unknown) => void;
  readonly error: (message: string, detail?: unknown) => void;
}
