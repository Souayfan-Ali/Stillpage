/**
 * Worker logger (tooling notes §4). Keeps the last entries of this wake in memory; development builds
 * also print them. Release builds print nothing (`import.meta.env.DEV` is compiled out).
 */
import type { Logger } from '../core/log.js';

const MAX_ENTRIES = 50;

interface Entry {
  readonly level: 'warn' | 'error';
  readonly message: string;
  readonly detail: unknown;
}

export function createLogger(print: boolean): Logger & { entries: () => readonly Entry[] } {
  let entries: readonly Entry[] = [];
  const add = (level: Entry['level'], message: string, detail: unknown): void => {
    entries = [...entries, { level, message, detail }].slice(-MAX_ENTRIES);
    // The one console call in shipped code: this is the logger, and `print` is false in release builds.
    if (print) console[level](`[worker] ${message}`, detail ?? '');
  };
  return {
    warn: (message, detail) => {
      add('warn', message, detail);
    },
    error: (message, detail) => {
      add('error', message, detail);
    },
    entries: () => entries,
  };
}
