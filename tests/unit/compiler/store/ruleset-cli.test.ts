/**
 * D-71: the store CLI pieces shared by the npm `release` CLI and the key job's plain-node uploader, in process
 * (the spawn test in `uploader.test.ts` proves plain `node` runs them; this one covers their paths).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sha256Hex } from '../../../../compiler/release/record.js';
import { publishRulesetCommand, statusCommand, virtualClock } from '../../../../compiler/store/ruleset-cli.js';
import { extensionZip } from '../release/fixtures.js';

const ZIP = extensionZip({ version: '1.0.318.600' });
let dir: string;
let out: string[];
const file = (name: string, data: string | Uint8Array): string => { const f = path.join(dir, name); writeFileSync(f, data); return f; };
const verdict = (v: object): string => file(`v${String(Math.random()).slice(2)}.json`, JSON.stringify(v));
const good = (): string => verdict({ outcome: 'publish', candidateSha256: sha256Hex(ZIP) });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ruleset-cli-'));
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  process.exitCode = undefined;
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; vi.unstubAllEnvs(); });

describe('publishRulesetCommand (dry run)', () => {
  test('publishes the checked zip through the fake and prints the requests; exit 0', async () => {
    await publishRulesetCommand(['--zip', file('c.zip', ZIP), '--verdict', good(), '--fake-published', '1.0.317.600']);
    const text = out.join('');
    expect(text).toMatch(/dry run: recorded-contract fake \(scenario live\)/);
    expect(text).toMatch(/dry-run request: POST .*:publish \{"publishType":"DEFAULT_PUBLISH","skipReview":true\}/);
    expect(text).toMatch(/"kind":"live","version":"1\.0\.318\.600"/);
    expect(process.exitCode).toBe(0);
  });

  test.each([
    ['stays-in-review', 1],
    ['refused', 1],
    ['pending-full-release', 5],
  ])('scenario %s → exit %i', async (scenario, code) => {
    await publishRulesetCommand(['--zip', file('c.zip', ZIP), '--verdict', good(), '--fake-published', '1.0.317.600', '--fake-scenario', scenario]);
    expect(process.exitCode).toBe(code);
  });

  test.each([
    ['no --zip', () => [], /--zip <candidate zip> is required/],
    ['no --verdict', () => ['--zip', file('c.zip', ZIP)], /--verdict <gate output> is required/],
    ['a verdict without fields', () => ['--zip', file('c.zip', ZIP), '--verdict', verdict({ outcome: 'publish' })], /has no outcome and candidateSha256/],
    ['a verdict that is an array', () => ['--zip', file('c.zip', ZIP), '--verdict', file('a.json', '[]')], /has no outcome and candidateSha256/],
    ['a verdict that is not publish', () => ['--zip', file('c.zip', ZIP), '--verdict', verdict({ outcome: 'abort', candidateSha256: sha256Hex(ZIP) })], /is "abort", not "publish"/],
    ['a verdict for other bytes', () => ['--zip', file('c.zip', ZIP), '--verdict', verdict({ outcome: 'publish', candidateSha256: '0'.repeat(64) })], /for another zip/],
    ['an unknown scenario', () => ['--zip', file('c.zip', ZIP), '--verdict', good(), '--fake-scenario', 'nope'], /unknown --fake-scenario nope/],
    ['--live with the placeholder store ids', () => ['--zip', file('c.zip', ZIP), '--verdict', good(), '--live'], /needs the owner's ids/],
  ])('%s → refuses', async (_name, args, message) => {
    await expect(publishRulesetCommand(args())).rejects.toThrow(message);
  });
});

describe('statusCommand (dry run)', () => {
  test('prints the E11 store state from the fake', async () => {
    await statusCommand(['--fake-published', '1.0.317.600']);
    expect(out.join('')).toMatch(/\{"published":true,"warned":false,"pendingSubmission":false,"publishedVersion":"1\.0\.317\.600"\}/);
  });
});

describe('virtualClock', () => {
  test('sleeping advances time without waiting', async () => {
    const c = virtualClock();
    await c.sleep(90_000);
    expect(c.now()).toBe(90_000);
  });
});
