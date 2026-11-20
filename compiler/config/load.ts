/** Reads and validates the compiler's JSON inputs (files are untrusted until parsed). */
import { readFile } from 'node:fs/promises';
import type { z } from 'zod';
import { EMPTY_LOCK, LockFileSchema, type LockFile } from '../fetch/lock.js';
import { ListsConfigSchema, type ListsConfig } from './schema.js';

/** Parses `text` as JSON and validates it; the error names the file and every issue. */
export function parseJsonWith<S extends z.ZodType>(schema: S, text: string, name: string): z.infer<S> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`${name}: not valid JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`${name}: ${issues.join('; ')}`);
  }
  return parsed.data;
}

export async function loadListsConfig(file: string): Promise<ListsConfig> {
  return parseJsonWith(ListsConfigSchema, await readFile(file, 'utf8'), file);
}

/** The lock at `file`, or an empty lock when the file does not exist yet. */
export async function loadLock(file: string): Promise<LockFile> {
  try {
    return parseJsonWith(LockFileSchema, await readFile(file, 'utf8'), file);
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return EMPTY_LOCK;
    throw e;
  }
}
