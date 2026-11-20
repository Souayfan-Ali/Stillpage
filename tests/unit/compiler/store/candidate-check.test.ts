/**
 * D-58 (finding D2): the publish job recomputes the verdict from the bytes. These tests forge what a compromised
 * `candidate` job could hand over: a zip that changes more than safe rulesets, and a verdict that says "publish".
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { recordOf, sha256Hex } from '../../../../compiler/release/record.js';
import { repack } from '../../../../compiler/release/repack.js';
import { readZip, writeZip } from '../../../../compiler/release/zip.js';
import { checkRulesetCandidate, type CandidateCheckInput } from '../../../../compiler/store/candidate/check.js';
import { BYTE_GROWTH_LIMIT, CONDITION_KEYS, RULE_GROWTH_LIMIT } from '../../../../compiler/store/candidate/rules.js';
import { DnrRuleSchema } from '../../../../compiler/dnr/schema.js';
import { BASE_FILES, block, extensionZip, manifestText, redirect, rulesText, text, UBO_RULES } from '../release/fixtures.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const BASE = extensionZip();
const NEXT = '1.0.318.600';
const NEW_UBO = rulesText([...UBO_RULES, block(21, 'n21.example')]);

const repacked = (rulesets: Readonly<Record<string, string>>, version = NEXT): Uint8Array =>
  repack({ base: BASE, rulesets: new Map(Object.entries(rulesets).map(([p, t]) => [p, text(t)])), version });

/** A candidate written directly (not through repack), as a forged artefact would be. */
const forged = (files: Readonly<Record<string, string>>, manifest = manifestText(NEXT)): Uint8Array =>
  extensionZip({ manifest, files: { ...BASE_FILES, 'rulesets/ubo.json': NEW_UBO, ...files } });

const input = (candidate: Uint8Array, base = BASE): CandidateCheckInput => ({ base, candidate, expectedBaseSha256: recordOf(base).zipSha256 });
const problems = (candidate: Uint8Array): readonly string[] => checkRulesetCandidate(input(candidate)).problems;

describe('ruleset candidate check in the publish job (D-58)', () => {
  test('a clean repack passes and names its bytes and versions', () => {
    const candidate = repacked({ 'rulesets/ubo.json': NEW_UBO, 'rulesets/easylist.json': rulesText([block(1, 'banners.example')]) });
    expect(checkRulesetCandidate(input(candidate))).toEqual({
      outcome: 'publish', candidateSha256: sha256Hex(candidate), candidateVersion: NEXT, baseVersion: '1.0.317.600', problems: [],
    });
  });

  test('a forged zip written by hand in canonical form passes only when it changes nothing but safe rulesets', () => {
    expect(problems(forged({}))).toEqual([]);
  });

  test('the base must be the expected published zip', () => {
    const v = checkRulesetCandidate({ ...input(forged({})), expectedBaseSha256: 'a'.repeat(64) });
    expect(v.outcome).toBe('abort');
    expect(v.problems).toEqual([expect.stringMatching(/^base zip SHA-256 .* is not the expected a{64}$/)]);
    expect(checkRulesetCandidate({ ...input(forged({})), expectedBaseSha256: 'not-a-hash' }).problems).toEqual(['expected base SHA-256 is not 64 lower-case hex digits']);
  });

  test.each([
    ['an extra file', { 'evil.js': 'steal()' }, ['added: evil.js']],
    ['an extra ruleset file', { 'rulesets/new.json': '[]' }, ['added: rulesets/new.json']],
    ['changed JS', { 'background.js': 'fetch("https://evil.example")' }, ['changed outside the safe rulesets: background.js']],
    ['a changed catalog', { 'catalog.json': '{}' }, ['changed outside the safe rulesets: catalog.json']],
    ['a changed -x ruleset', { 'rulesets/ubo-x.json': rulesText([redirect(1, 'other.example')]) }, ['-x ruleset changed: rulesets/ubo-x.json']],
  ])('%s → abort', (_name, files, expected) => {
    expect(problems(forged(files))).toEqual(expected);
  });

  test('a removed file → abort', () => {
    const entries = readZip(forged({})).filter((e) => e.path !== 'background.js');
    expect(problems(writeZip(entries))).toEqual(['removed: background.js']);
  });

  test('a changed file under rulesets/ that the base manifest does not declare → abort', () => {
    const base = extensionZip({ files: { ...BASE_FILES, 'rulesets/stale.json': '[]' } });
    const candidate = extensionZip({ manifest: manifestText(NEXT), files: { ...BASE_FILES, 'rulesets/stale.json': rulesText([block(1, 'a.example')]) } });
    expect(checkRulesetCandidate(input(candidate, base)).problems).toEqual(['changed outside the safe rulesets: rulesets/stale.json']);
  });

  test.each([
    ['a new permission', manifestText(NEXT).replace('["declarativeNetRequest"]', '["declarativeNetRequest","tabs"]'), ['manifest.json differs from the base in more than the "version" value']],
    ['a new key', manifestText(NEXT, ',"host_permissions":["<all_urls>"]'), ['manifest.json differs from the base in more than the "version" value']],
    ['reformatting', manifestText(NEXT).replace(',', ', '), ['manifest.json differs from the base in more than the "version" value']],
    ['an older version', manifestText('1.0.317.500'), ['candidate 1.0.317.500 is not later than 1.0.317.600']],
    ['the same version', manifestText('1.0.317.600'), ['candidate 1.0.317.600 is not later than 1.0.317.600']],
    ['a new code line', manifestText('1.1.318.600'), ['candidate 1.1.318.600 changes the code line of 1.0.317.600']],
    ['a version outside the scheme', manifestText('1.0.318'), ['candidate version 1.0.318 is outside the scheme']],
  ])('manifest with %s → abort', (_name, manifest, expected) => {
    expect(problems(forged({}, manifest))).toEqual(expected);
  });

  test('a base manifest whose version cannot be rewritten alone → abort', () => {
    const base = extensionZip({ manifest: manifestText('1.0.317.600', ',"version_name":"x"') });
    const candidate = extensionZip({ manifest: manifestText(NEXT, ',"version_name":"x"'), files: { ...BASE_FILES, 'rulesets/ubo.json': NEW_UBO } });
    expect(checkRulesetCandidate(input(candidate, base)).problems).toEqual(['base manifest has version_name or not exactly one "version" key']);
  });

  /** The base's ubo rules with the last one replaced: same count, about the same size. */
  const withRule = (rule: object): string => rulesText([...UBO_RULES.slice(0, -1), rule]);
  const cond = { requestDomains: ['a.example'] };

  test.each([
    ['a redirect rule', rulesText([...UBO_RULES, redirect(21, 'x.example')]), 'rulesets/ubo.json: rule 21 has action "redirect", not a skip-review safe action'],
    ['a modifyHeaders rule', rulesText([{ id: 1, action: { type: 'modifyHeaders', requestHeaders: [] }, condition: {} }]), 'rulesets/ubo.json: rule 1 has action "modifyHeaders", not a skip-review safe action'],
    ['a rule without an action', rulesText([{ id: 1, condition: {} }]), 'rulesets/ubo.json: rule 1 has action "none", not a skip-review safe action'],
    ['a duplicate id', rulesText([block(1, 'a.example'), block(1, 'b.example')]), 'rulesets/ubo.json: rule id 1 is used twice'],
    ['a non-integer id', rulesText([{ ...block(1, 'a.example'), id: 1.5 }]), 'rulesets/ubo.json: rule 0 has no positive integer id'],
    ['a non-object rule', '[1]', 'rulesets/ubo.json: rule 0 has no positive integer id'],
    ['not a list', '{}', 'rulesets/ubo.json: not a rule list'],
    ['a duplicate key', '[{"id":1,"action":{"type":"redirect","type":"block"},"condition":{}}]', 'rulesets/ubo.json: not in the compact canonical JSON form (duplicate keys or reformatting)'],
    ['reformatting', ' []', 'rulesets/ubo.json: not in the compact canonical JSON form (duplicate keys or reformatting)'],
    ['broken JSON', '[', expect.stringMatching(/^rulesets\/ubo\.json: not JSON/)],
    ['an unknown rule key', withRule({ id: 20, action: { type: 'block' }, condition: cond, __x: 1 }), 'rulesets/ubo.json: rule 20 has unknown keys __x'],
    ['a redirect payload on a block', withRule({ id: 20, action: { type: 'block', redirect: { url: 'https://evil.example' } }, condition: cond }), 'rulesets/ubo.json: rule 20 has an action with keys other than "type"'],
    ['headers on an allow', withRule({ id: 20, action: { type: 'allow', requestHeaders: [] }, condition: cond }), 'rulesets/ubo.json: rule 20 has an action with keys other than "type"'],
    ['no condition', withRule({ id: 20, action: { type: 'block' } }), 'rulesets/ubo.json: rule 20 has no condition object'],
    ['an unknown condition key', withRule({ id: 20, action: { type: 'block' }, condition: { ...cond, tabIds: [1] } }), 'rulesets/ubo.json: rule 20 has unknown condition keys tabIds'],
    ['priority 0', withRule({ id: 20, priority: 0, action: { type: 'block' }, condition: cond }), 'rulesets/ubo.json: rule 20 has a priority that is not a positive integer'],
    ['a fractional priority', withRule({ id: 20, priority: 1.5, action: { type: 'block' }, condition: cond }), 'rulesets/ubo.json: rule 20 has a priority that is not a positive integer'],
    ['a catch-all allowAllRequests', withRule({ id: 20, action: { type: 'allowAllRequests' }, condition: { urlFilter: '*', resourceTypes: ['main_frame'] } }), 'rulesets/ubo.json: rule 20 is a catch-all "allowAllRequests" that names no site'],
    ['a catch-all allow with empty domain lists', withRule({ id: 20, action: { type: 'allow' }, condition: { urlFilter: '|https://', requestDomains: [], initiatorDomains: [] } }), 'rulesets/ubo.json: rule 20 is a catch-all "allow" that names no site'],
    ['a catch-all allow scoped only by topDomains', withRule({ id: 20, action: { type: 'allow' }, condition: { topDomains: ['a.example'] } }), 'rulesets/ubo.json: rule 20 is a catch-all "allow" that names no site'],
    ['an allow with a trivial regex', withRule({ id: 20, action: { type: 'allow' }, condition: { regexFilter: '^https?:\\/\\/.*' } }), 'rulesets/ubo.json: rule 20 is a catch-all "allow" that names no site'],
    ['a block of every page', withRule({ id: 20, action: { type: 'block' }, condition: { urlFilter: '||', resourceTypes: ['main_frame'] } }), 'rulesets/ubo.json: rule 20 is a catch-all "block" that names no site'],
    ['20 % more rules', rulesText([...UBO_RULES, block(21, 'a.example'), block(22, 'b.example'), block(23, 'c.example'), block(24, 'd.example')]),
      'rulesets/ubo.json: rule count 20 → 24 (20.0 %), more than the growth guard'],
  ])('a changed safe ruleset with %s → abort', (_name, rules, expected) => {
    expect(problems(forged({ 'rulesets/ubo.json': rules }))).toEqual([expected]);
  });

  test.each([
    ['a site-scoped allow', { id: 20, action: { type: 'allow' }, condition: { urlFilter: '||a.example^' } }],
    ['an allow with a site regex', { id: 20, action: { type: 'allow' }, condition: { regexFilter: '^https://a\\.example/' } }],
    ['an allow by initiator', { id: 20, action: { type: 'allowAllRequests' }, condition: { initiatorDomains: ['a.example'], resourceTypes: ['main_frame'] } }],
    ['a broad block of scripts (not main_frame)', { id: 20, priority: 2, action: { type: 'block' }, condition: { urlFilter: '*', resourceTypes: ['script'] } }],
    ['an upgradeScheme', { id: 20, action: { type: 'upgradeScheme' }, condition: { urlFilter: '|http://' } }],
  ])('%s passes', (_name, rule) => {
    expect(problems(forged({ 'rulesets/ubo.json': withRule(rule) }))).toEqual([]);
  });

  test('more than 25 % bytes → abort; an unreadable base ruleset → abort, never skip', () => {
    const long = UBO_RULES.map((_, i) => block(i + 1, `${'x'.repeat(40)}${String(i)}.example`));
    expect(problems(forged({ 'rulesets/ubo.json': rulesText(long) }))).toEqual([expect.stringMatching(/^rulesets\/ubo\.json: bytes changed by \d+\.\d %, more than the growth guard$/)]);
    const base = extensionZip({ files: { ...BASE_FILES, 'rulesets/ubo.json': 'not json' } });
    expect(checkRulesetCandidate(input(forged({}), base)).problems).toEqual([expect.stringMatching(/^base rulesets\/ubo\.json: not JSON/)]);
  });

  test('a base manifest that declares one path twice → abort', () => {
    const twice = manifestText('1.0.317.600').replace('"path":"rulesets/easylist.json"', '"path":"rulesets/ubo.json"');
    const base = extensionZip({ manifest: twice });
    const candidate = extensionZip({ manifest: twice.replace('1.0.317.600', NEXT), files: { ...BASE_FILES, 'rulesets/ubo.json': NEW_UBO } });
    expect(checkRulesetCandidate(input(candidate, base)).problems).toEqual(['base manifest declares a rule_resources path twice']);
  });

  test('invalid UTF-8 in a ruleset → abort', () => {
    const entries = readZip(forged({})).map((e) => (e.path === 'rulesets/ubo.json' ? { path: e.path, data: new Uint8Array([0x5b, 0xff, 0x5d]) } : e));
    expect(problems(writeZip(entries))).toEqual([expect.stringMatching(/^rulesets\/ubo\.json: not JSON/)]);
  });

  test('a candidate not in the deterministic repack layout (bytes before the first entry) → abort', () => {
    const good = forged({});
    const shifted = new Uint8Array([...new Uint8Array(4), ...good]);
    const v = checkRulesetCandidate(input(shifted));
    expect(v.outcome).toBe('abort');
    expect(v.problems.join('\n')).toMatch(/not a zip in the repack's deterministic layout|unreadable/);
  });

  test('unreadable zips or manifests → abort, never a throw', () => {
    expect(problems(new Uint8Array([1, 2, 3]))).toEqual([expect.stringMatching(/^unreadable candidate: /)]);
    const junk = text('junk');
    expect(checkRulesetCandidate({ base: junk, candidate: forged({}), expectedBaseSha256: sha256Hex(junk) }).problems).toEqual([expect.stringMatching(/^unreadable base: /)]);
    const noManifest = writeZip(readZip(forged({})).filter((e) => e.path !== 'manifest.json'));
    expect(problems(noManifest)).toEqual(['unreadable candidate: zip has no manifest.json']);
    for (const manifest of ['[]', '{"version":1}', '{"version":"1.0.318.600","declarative_net_request":{"rule_resources":[{"id":1}]}}', '{"version":"1.0.318.600","declarative_net_request":{}}']) {
      expect(problems(forged({}, manifest))[0]).toMatch(/^unreadable candidate: manifest\.json /);
    }
  });

  test('a forged verdict changes nothing: the check reads no verdict, only bytes', () => {
    const evil = forged({ 'background.js': 'steal()' });
    const artefactVerdict = { outcome: 'publish', candidateSha256: sha256Hex(evil), checks: [] };
    const v = checkRulesetCandidate({ ...input(evil), ...({ verdict: artefactVerdict } as object) });
    expect(v.outcome).toBe('abort');
    expect(v.candidateSha256).toBe(sha256Hex(evil));
  });
});

/** Relative imports of a source file (static `import … from` / `import '…'`). */
const importsOf = (file: string): readonly string[] =>
  [...readFileSync(file, 'utf8').matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');

describe('the checker stays equal to the compiler it re-checks (D-58f)', () => {
  test('condition keys are the DNR schema\'s', () => {
    expect([...CONDITION_KEYS].sort()).toEqual(Object.keys(DnrRuleSchema.shape.condition.shape).sort());
  });

  test('growth limits are E10\'s', () => {
    const e10 = readFileSync(path.join(ROOT, 'compiler/eligibility/rules.ts'), 'utf8');
    expect(e10).toMatch(new RegExp(`^const RULE_GROWTH_LIMIT = ${String(RULE_GROWTH_LIMIT)};$`, 'm'));
    expect(e10).toMatch(new RegExp(`^const BYTE_GROWTH_LIMIT = ${String(BYTE_GROWTH_LIMIT)};$`, 'm'));
  });
});

describe('the checker is dependency-free (D-58b)', () => {
  test('its transitive imports are node: built-ins plus zip.ts and version.ts', () => {
    const seen = new Set<string>();
    const external = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
        else external.add(spec);
      }
    };
    walk(path.join(ROOT, 'compiler/store/candidate/main.ts'));
    expect([...external].filter((s) => !s.startsWith('node:'))).toEqual([]);
    expect([...seen].map((f) => path.relative(ROOT, f)).sort()).toEqual([
      'compiler/release/zip.ts', 'compiler/store/candidate/check.ts', 'compiler/store/candidate/main.ts', 'compiler/store/candidate/rules.ts',
      'src/core/version.ts',
    ]);
  });

  test('plain node runs it (no npm packages, no loader): forged zip → exit 1, clean repack → exit 0 with the verdict file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'candidate-check-'));
    const write = (name: string, bytes: Uint8Array): string => { const f = path.join(dir, name); writeFileSync(f, bytes); return f; };
    const base = write('base.zip', BASE);
    const run = (candidate: Uint8Array) => spawnSync(process.execPath, [path.join(ROOT, 'compiler/store/candidate/main.ts'),
      '--base', base, '--candidate', write('candidate.zip', candidate), '--base-sha256', sha256Hex(BASE), '--out', path.join(dir, 'out/verdict.json')],
    { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    expect(run(forged({ 'background.js': 'steal()' })).status).toBe(1);
    const ok = run(repacked({ 'rulesets/ubo.json': NEW_UBO }));
    expect(ok.status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, 'out/verdict.json'), 'utf8'))).toMatchObject({ outcome: 'publish', candidateVersion: NEXT });
    expect(run(BASE).stderr + run(BASE).stdout).toMatch(/not later than/);
    const missing = spawnSync(process.execPath, [path.join(ROOT, 'compiler/store/candidate/main.ts')], { encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/--base, --candidate, --base-sha256 and --out are required/);
  });
});
