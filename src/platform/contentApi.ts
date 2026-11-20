/**
 * The extension API for scripts registered on pages (P2-47). Read when called, never at module load:
 * WXT's `wxt/browser` reads `browser?.runtime?.id` when its module loads, and Chrome exposes `browser`
 * in isolated worlds, so every frame paid the first `runtime` touch (≈ 0.46 ms at 1× vs ≈ 0.03 ms for an
 * empty script, CDP ScriptDuration). Type-only import: nothing of WXT's shim is bundled.
 */
import type { browser } from 'wxt/browser';

export const extensionApi = (): typeof browser => (globalThis as unknown as { readonly chrome: typeof browser }).chrome;
