import { describe, expect, test } from 'vitest';
import { WORKER_TERSER_OPTIONS, workerBuildConfig } from '../../../scripts/build/workerMinify.js';

const base = { outDir: '/x', minify: 'esbuild', rollupOptions: { input: 'a' } } as const;

describe('worker-only terser (D-75)', () => {
  test('the background group gets terser with the pinned options, the rest of its build config kept', () => {
    const next = workerBuildConfig([{ type: 'background' }], base);
    expect(next).toEqual({ ...base, minify: 'terser', terserOptions: WORKER_TERSER_OPTIONS });
    expect(base.minify).toBe('esbuild');
  });

  test.each([
    ['a content script', [{ type: 'content-script' }]],
    ['an unlisted script (popup-sentinel, popup-shim)', [{ type: 'unlisted-script' }]],
    ['the extension pages', [{ type: 'popup' }, { type: 'unlisted-page' }]],
    ['a group that holds the background with another entry', [{ type: 'background' }, { type: 'popup' }]],
  ])('%s keeps its build config unchanged', (_name, group) => {
    expect(workerBuildConfig(group, base)).toBe(base);
  });

  test('a missing build config is created only for the background', () => {
    expect(workerBuildConfig([{ type: 'background' }], undefined)).toEqual({ minify: 'terser', terserOptions: WORKER_TERSER_OPTIONS });
    expect(workerBuildConfig([{ type: 'popup' }], undefined)).toBeUndefined();
  });

  test('only the D-75 allowed options: compress passes <= 3, default mangle, no unsafe, module or toplevel transforms', () => {
    const { compress, mangle, ...rest } = WORKER_TERSER_OPTIONS;
    expect(rest).toEqual({});
    expect(mangle).toBe(true);
    expect(Object.keys(compress)).toEqual(['passes']);
    expect(compress.passes).toBeLessThanOrEqual(3);
  });
});
