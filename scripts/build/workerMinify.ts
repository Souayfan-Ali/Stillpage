/**
 * D-75 (P3-14): the service worker alone is minified with terser; every other entry keeps Vite's esbuild
 * minifier, byte for byte (pinned by `tests/e2e/workerMinify.spec.ts`). Only `compress.passes` and the
 * default `mangle` are allowed: no `unsafe*`, `module`, `toplevel`, property mangling, `pure_*`, `drop_console`
 * or `keep_fargs`. With `module: true` terser deleted content-script code (P3-14 notes), hence the ban.
 */
export const WORKER_TERSER_OPTIONS = { compress: { passes: 3 }, mangle: true } as const;

interface EntryLike {
  readonly type: string;
}

interface BuildLike {
  readonly minify?: unknown;
  readonly terserOptions?: unknown;
}

/** The build config for one WXT entry group: a new object for the background group, the same one otherwise. */
export function workerBuildConfig<B extends BuildLike>(group: readonly EntryLike[], build: B | undefined): B | undefined {
  const isWorker = group.length === 1 && group[0]?.type === 'background';
  if (!isWorker) return build;
  return { ...build, minify: 'terser', terserOptions: WORKER_TERSER_OPTIONS } as B;
}
