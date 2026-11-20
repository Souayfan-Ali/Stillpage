/**
 * D-73: the daily ruleset job's lift drift report. The SHIPPED `popup-lifted.json` (base zip) is checked against
 * the candidate zip's rulesets; drift never fails the run (exit 0) and only warns with the D-55a deadline; bad
 * input fails closed.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { liftDriftCommand, liftDriftOfZips } from '../../../../compiler/release/cli-lift.js';
import { writeZip } from '../../../../compiler/release/zip.js';
import { text } from './fixtures.js';

const RESOURCES = [
  { id: 'easylist', enabled: true, path: 'rulesets/easylist.json' },
  { id: 'ubo', enabled: true, path: '/rulesets/ubo.json' },
  { id: 'badware', enabled: true, path: 'rulesets/badware.json' },
  { id: 'ubo-x', enabled: false, path: 'rulesets/ubo-x.json' },
];
const manifest = JSON.stringify({ manifest_version: 3, version: '1.0.1.1', declarative_net_request: { rule_resources: RESOURCES } });
const docBlock = (id: number, host: string): object => ({ id, priority: 10, action: { type: 'block' }, condition: { requestDomains: [host], resourceTypes: ['main_frame'] } });

interface Spec { readonly easylist?: readonly object[]; readonly badware?: readonly object[]; readonly lifted?: string | null }
function zip(spec: Spec): Uint8Array {
  const files: Record<string, string> = {
    'manifest.json': manifest,
    'rulesets/easylist.json': JSON.stringify(spec.easylist ?? [docBlock(1, 'a-ads.com')]),
    'rulesets/ubo.json': '[]',
    'rulesets/badware.json': JSON.stringify(spec.badware ?? []),
    'rulesets/ubo-x.json': '[]',
  };
  const lifted = spec.lifted === undefined ? '{"easylist":["a-ads.com"]}' : spec.lifted;
  return writeZip(Object.entries({ ...files, ...(lifted === null ? {} : { 'popup-lifted.json': lifted }) }).map(([p, d]) => ({ path: p, data: text(d) })));
}
const TODAY = '2026-11-14';
const BASE = zip({});

describe('liftDriftOfZips (D-73)', () => {
  test('no drift: report without a warning', () => {
    const r = liftDriftOfZips({ base: BASE, candidate: zip({}), today: TODAY });
    expect(r.report).toMatchObject({ schema: 1, drift: false, fullReleaseWithinHours: null, detectedOn: TODAY, baseHasLiftFile: true });
    expect(r.annotation).toBeNull();
  });

  test('other drift (the host is no longer document-blocked): 168 h, warning without an absolute deadline', () => {
    const r = liftDriftOfZips({ base: BASE, candidate: zip({ easylist: [docBlock(1, 'other.example')] }), today: TODAY });
    expect(r.report).toMatchObject({ drift: true, fullReleaseWithinHours: 168, violations: { unjustified: ['a-ads.com'] } });
    expect(r.annotation).toBe('::warning::lift drift (other): full release required within 168 h of first detection');
  });

  test('malware drift (badware now blocks a lifted host): 48 h', () => {
    const r = liftDriftOfZips({ base: BASE, candidate: zip({ badware: [docBlock(1, 'a-ads.com')] }), today: TODAY });
    expect(r.report).toMatchObject({ drift: true, fullReleaseWithinHours: 48, violations: { malware: ['a-ads.com'] } });
    expect(r.annotation).toBe('::warning::lift drift (malware): full release required within 48 h of first detection');
  });

  test('a base published before D-55 (no popup-lifted.json): nothing to check, a warning, no failure (security review MEDIUM 3)', () => {
    const r = liftDriftOfZips({ base: zip({ lifted: null }), candidate: zip({}), today: TODAY });
    expect(r.report).toMatchObject({ drift: false, baseHasLiftFile: false, fullReleaseWithinHours: null, detectedOn: TODAY });
    expect(r.annotation).toBe('::warning::lift drift: the published base has no popup-lifted.json (built before D-55); nothing to check');
  });

  test.each([
    ['a lift file that is not host lists', { base: zip({ lifted: '{"easylist":"a-ads.com"}' }) }, /popup-lifted\.json/],
    ['a ruleset that is not JSON', { broken: true }, /rulesets\/easylist\.json/],
    ['a bad date', { today: '14/11/2026' }, /--today/],
  ])('%s → throws (fail closed)', (_name, over, message) => {
    const candidate = 'broken' in over
      ? writeZip([{ path: 'manifest.json', data: text(manifest) }, { path: 'rulesets/easylist.json', data: text('[') }, { path: 'rulesets/ubo.json', data: text('[]') },
        { path: 'rulesets/badware.json', data: text('[]') }, { path: 'rulesets/ubo-x.json', data: text('[]') }])
      : zip({});
    const input = { base: BASE, candidate, today: TODAY, ...('base' in over ? { base: over.base } : {}), ...('today' in over ? { today: over.today } : {}) };
    expect(() => liftDriftOfZips(input)).toThrow(message);
  });
});

describe('liftDriftCommand (D-73)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test('writes the report and prints the warning; exits normally with drift', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lift-drift-'));
    const base = path.join(dir, 'base.zip');
    const candidate = path.join(dir, 'candidate.zip');
    writeFileSync(base, BASE);
    writeFileSync(candidate, zip({ easylist: [] }));
    const out = path.join(dir, 'out/lift-drift.json');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await liftDriftCommand(['--base', base, '--candidate', candidate, '--today', TODAY, '--out', out]);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ drift: true, detectedOn: TODAY, fullReleaseWithinHours: 168 });
    expect(stdout.mock.calls.map((c) => String(c[0])).join('')).toContain('::warning::lift drift (other)');
  });

  test('missing arguments → throws', async () => {
    await expect(liftDriftCommand([])).rejects.toThrow(/--base, --candidate, --today and --out are required/);
  });
});
