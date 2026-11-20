/** Shared helpers for the Chromium-backed compiler suites. */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { PROFILE_PREFIX } from '../../compiler/chromium/node-ports.js';

export { compileSplit as compileLines } from '../helpers/compileFilters.js';

const WORK_DIR = path.resolve(import.meta.dirname, '../../.cache/compiler');

/** Fails when a Chromium started by the compiler port is still running or left a profile behind. */
export function expectNoSurvivors(): void {
  let running = '';
  try {
    running = execFileSync('pgrep', ['-af', PROFILE_PREFIX], { encoding: 'utf8' });
  } catch {
    running = '';
  }
  const procs = running.split('\n').filter((l) => l !== '' && !l.includes('pgrep'));
  let left: string[] = [];
  try {
    left = readdirSync(WORK_DIR).filter((d) => d.startsWith(PROFILE_PREFIX) || d.startsWith('ext-'));
  } catch {
    left = [];
  }
  expect([...procs, ...left]).toEqual([]);
}
