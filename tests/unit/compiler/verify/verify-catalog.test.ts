/**
 * Verify stage (P1-31): the catalog as the worker reads it (`registrations.json` behind its SHA-256,
 * D-26), the catalog-level budgets, and the rule checks' edge cases (missing priority, a safe action
 * in a `-x` file, the static regex pool, pop-up artefacts that are absent or not string arrays).
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { rulesetPath } from '../../../../compiler/emit/emit.js';
import { verifyArtefacts, type VerifyInput } from '../../../../compiler/verify/verify.js';
import { DEFAULT_PATTERN_BUDGET, STATIC_REGEX_POOL } from '../../../../src/core/limits.js';
import { b, built, POPUPS } from './helpers.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

interface RawCatalog { readonly rulesets: Record<string, unknown>; readonly packs: Record<string, Record<string, unknown>> }

const catalogOf = (i: VerifyInput): RawCatalog => JSON.parse(i.files.get('catalog.json') ?? '{}') as RawCatalog;

/** The build's files with `catalog.json` (and optionally other files) replaced. */
function withFiles(i: VerifyInput, set: Readonly<Record<string, string>>, drop: readonly string[] = []): VerifyInput {
  const files = new Map([...i.files].filter(([p]) => !drop.includes(p)));
  return { ...i, files: new Map([...files, ...Object.entries(set)]) };
}

/** A catalog that names `registrations.json` by `hash`, with that file holding `regs` (when given). */
function withRegistrations(i: VerifyInput, regs: string | undefined, hash = sha(regs ?? '')): VerifyInput {
  const catalog = { ...catalogOf(i), registrations: { path: 'registrations.json', sha256: hash } };
  return regs === undefined
    ? withFiles(i, { 'catalog.json': JSON.stringify(catalog) }, ['registrations.json'])
    : withFiles(i, { 'catalog.json': JSON.stringify(catalog), 'registrations.json': regs });
}

const firstPack = (i: VerifyInput): string => Object.keys(catalogOf(i).packs)[0] ?? '';

describe('verify stage: registrations.json behind the catalog (D-26)', () => {
  test('the catalog names registrations.json but the file is missing', async () => {
    expect(verifyArtefacts(withRegistrations(await built(), undefined)).failures).toContain('catalog names registrations.json but there is no file');
  });

  test('a registrations.json whose bytes do not match the catalog SHA-256 fails', async () => {
    const failures = verifyArtefacts(withRegistrations(await built(), '{"schema":1,"packs":{}}', sha('other'))).failures;
    expect(failures).toContain("registrations.json does not match the catalog's SHA-256");
  });

  test('a matching but malformed registrations.json is invalid', async () => {
    expect(verifyArtefacts(withRegistrations(await built(), '{"schema":2,"packs":{}}')).failures).toContain('invalid registrations.json');
  });

  test('a matching, well-formed registrations.json is merged and passes', async () => {
    const i = await built();
    const regs = JSON.stringify({ schema: 1, packs: { [firstPack(i)]: [{ id: 'iso:x:0', world: 'ISOLATED', js: ['cosmetic/x/0.js'], hosts: ['a.example'] }] } });
    expect(verifyArtefacts(withRegistrations(i, regs)).failures).toEqual([]);
  });
});

describe('verify stage: catalog checks', () => {
  test('no catalog.json at all reports catalog errors and skips the ceiling check', async () => {
    const failures = verifyArtefacts(withFiles(await built(), {}, ['catalog.json'])).failures;
    expect(failures.some((f) => f.startsWith('catalog:'))).toBe(true);
    expect(failures.some((f) => f.includes('over the catalog ceiling'))).toBe(false);
  });

  test('a ruleset named by the catalog with no file and in no pack', async () => {
    const i = await built();
    const catalog = catalogOf(i);
    const ubo = catalog.rulesets['ubo'];
    const tight = { ...catalog, rulesets: { ...catalog.rulesets, ghost: ubo } };
    const failures = verifyArtefacts(withFiles(i, { 'catalog.json': JSON.stringify(tight) })).failures;
    expect(failures).toEqual(expect.arrayContaining(['catalog names ghost but there is no file', 'catalog: ruleset ghost is in no pack']));
  });

  test('default-pack registrations over the pattern budget fail', async () => {
    const i = await built();
    const catalog = catalogOf(i);
    const hosts = Array.from({ length: DEFAULT_PATTERN_BUDGET + 1 }, (_, n) => `h${String(n)}.example`);
    const registrations = [{ id: 'iso:big:0', world: 'ISOLATED', js: ['cosmetic/big/0.js'], hosts }];
    const target = Object.keys(catalog.packs).find((id) => catalog.packs[id]?.['default'] === true) ?? '';
    const packs = { ...catalog.packs, [target]: { ...catalog.packs[target], registrations } };
    const failures = verifyArtefacts(withFiles(i, { 'catalog.json': JSON.stringify({ ...catalog, packs }) })).failures;
    expect(failures).toContain(`${String(DEFAULT_PATTERN_BUDGET + 1)} match patterns for the default packs > ${String(DEFAULT_PATTERN_BUDGET)}`);
  });
});

describe('verify stage: rule edge cases', () => {
  test('a stock rule without a priority counts as priority 1, below the stock band', async () => {
    const i = await built({ ubo: [b({ action: { type: 'block' }, condition: { urlFilter: '||a.example/x.js' } })] });
    expect(verifyArtefacts(i).failures).toContain('ubo: 1 rule(s) outside the stock priority band');
  });

  test('a safe action in an unsafe (-x) file is named as such', async () => {
    const i = await built({ uboX: [b({ priority: 1110, action: { type: 'block' }, condition: { urlFilter: '||z.example^' } })] });
    expect(verifyArtefacts(i).failures.join('\n')).toMatch(/ubo-x: block rule \d+ in a -x file/);
  });

  test('more regex rules than the static pool fails', async () => {
    const i = await built();
    const many = Array.from({ length: STATIC_REGEX_POOL + 1 }, (_, n) => ({ id: n + 1, priority: 110, action: { type: 'block' }, condition: { regexFilter: `^https://r${String(n)}\\.example/` } }));
    const failures = verifyArtefacts(withFiles(i, { [rulesetPath('ubo')]: JSON.stringify(many) })).failures;
    expect(failures).toContain(`${String(STATIC_REGEX_POOL + 1)} regex over every ruleset > ${String(STATIC_REGEX_POOL)}`);
  });
});

describe('verify stage: pop-up artefact edge cases', () => {
  test('absent destination and Strict-site files read as empty lists', async () => {
    const i = withFiles(await built(), {}, ['popup-destinations.json', 'popup-strict-sites.json']);
    expect(verifyArtefacts(i).failures).toEqual([]);
  });

  test('a destinations file that is not a JSON string array is reported as a bad host', async () => {
    const failures = verifyArtefacts(withFiles(await built(), { 'popup-destinations.json': '{"a":1}' })).failures.join('\n');
    expect(failures).toMatch(/host\(s\) that are not site hosts \(e\.g\. <not a JSON string array>\)/);
  });

  test('initiator and excluded-initiator hosts are checked as rule hosts', async () => {
    const scoped = b({ priority: 1, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], requestDomains: ['pop.example'], initiatorDomains: ['com'], excludedInitiatorDomains: ['net'] } });
    const failures = verifyArtefacts(await built({ popups: [...POPUPS, scoped] })).failures.join('\n');
    expect(failures).toMatch(/2 host\(s\) that are not site hosts \(e\.g\. com, net\)/);
  });

  test('a regexFilter makes a pop-up rule the wrong shape', async () => {
    const regex = b({ priority: 1, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], regexFilter: '^https://p\\.example/' } });
    const failures = verifyArtefacts(await built({ popups: [...POPUPS, regex] })).failures;
    expect(failures).toContain('popups: 1 rule(s) not block/allow on main_frame with a host-anchored URL');
  });
});
