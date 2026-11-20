import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { readPreviousRulesets } from '../../../../compiler/build/node-ports.js';

/** P2-44: a first build has no previous rulesets; an unreadable directory is an error, not a first build. */
const roots: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'glassmere-previous-test-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('readPreviousRulesets', () => {
  test('reads every ruleset JSON by id and ignores other files', async () => {
    const dir = path.join(await tempDir(), 'rulesets');
    await mkdir(dir);
    await writeFile(path.join(dir, 'ubo.json'), '[1]');
    await writeFile(path.join(dir, 'notes.txt'), 'x');
    expect(await readPreviousRulesets(dir)).toEqual(new Map([['ubo', '[1]']]));
  });

  test('a missing directory is a first build: no previous rulesets', async () => {
    expect(await readPreviousRulesets(path.join(await tempDir(), 'absent'))).toEqual(new Map());
  });

  test('a path that is not a directory fails instead of looking like a first build', async () => {
    const file = path.join(await tempDir(), 'rulesets');
    await writeFile(file, 'not a directory');
    await expect(readPreviousRulesets(file)).rejects.toThrow(/ENOTDIR/);
  });
});
