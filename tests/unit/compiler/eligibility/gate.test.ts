import { describe, expect, test } from 'vitest';
import { runGate } from '../../../../compiler/eligibility/gate.js';
import type { CheckId, GateInput } from '../../../../compiler/eligibility/types.js';
import type { Ledger } from '../../../../compiler/postpass/ledger.js';
import { recordOf } from '../../../../compiler/release/record.js';
import { repack } from '../../../../compiler/release/repack.js';
import { queryKey } from '../../../../compiler/validate/regex.js';
import { BASE_FILES, block, CATALOG, extensionZip, manifestText, redirect, rulesText, text, UBO_RULES } from '../release/fixtures.js';

const BASE = extensionZip();
const NEXT = '1.0.318.600';
const ADDED = block(21, 'n21.example');

const ledger = (ruleset: string, n: number): Ledger =>
  ({ schema: 1, ruleset, nextId: n + 1, entries: Object.fromEntries(Array.from({ length: n }, (_, i) => [`r:${String(i + 1).padStart(20, '0')}`, i + 1])) });

/** Ledgers before / after with `ubo` given and the base's other slots unchanged. */
const ledgers = (before: Ledger | undefined, after: Ledger | undefined): GateInput['ledgers'] => {
  const others: [string, Ledger][] = [['easylist', ledger('easylist', 1)], ['ubo-x', ledger('ubo-x', 1)]];
  return { before: new Map([...others, ...(before ? [['ubo', before] as [string, Ledger]] : [])]), after: new Map([...others, ...(after ? [['ubo', after] as [string, Ledger]] : [])]) };
};

const candidateWith = (rules: readonly object[], version = NEXT): Uint8Array =>
  repack({ base: BASE, rulesets: new Map([['rulesets/ubo.json', text(rulesText(rules))]]), version });

/** A ruleset release that passes every check: one block rule added to `ubo`. */
function passing(): GateInput {
  return {
    base: BASE,
    candidate: candidateWith([...UBO_RULES, ADDED]),
    record: recordOf(BASE),
    ledgers: ledgers(ledger('ubo', 20), ledger('ubo', 21)),
    regexSupported: new Map(),
    load: { ok: true, problems: [] },
    store: { published: true, publishedVersion: '1.0.317.600', warned: false, pendingSubmission: false },
  };
}

/** `input` without one optional field (exactOptionalPropertyTypes forbids setting it to undefined). */
const without = (input: GateInput, field: 'load' | 'store'): GateInput =>
  Object.fromEntries(Object.entries(input).filter(([k]) => k !== field)) as unknown as GateInput;

const failed = (input: GateInput): readonly CheckId[] => runGate(input).checks.filter((c) => !c.pass).map((c) => c.id);

/** A candidate zip written directly (not through repack), for changes repack itself refuses. */
const rawCandidate = (files: Readonly<Record<string, string>>, manifest = manifestText(NEXT)): Uint8Array =>
  extensionZip({ manifest, files: { ...BASE_FILES, 'rulesets/ubo.json': rulesText([...UBO_RULES, ADDED]), ...files } });

describe('eligibility gate E1–E11 (update-strategy notes §3.3, P2-02)', () => {
  test('a clean ruleset release passes every check and may publish', () => {
    const v = runGate(passing());
    expect(v.checks.map((c) => c.id)).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11']);
    expect(v.checks.filter((c) => !c.pass)).toEqual([]);
    expect(v.outcome).toBe('publish');
  });

  test('E1: base zip that is not the recorded release → abort', () => {
    const other = extensionZip({ files: { ...BASE_FILES, 'background.js': 'changed' } });
    expect(failed({ ...passing(), record: recordOf(other) })).toEqual(['E1']);
    expect(failed({ ...passing(), store: { ...passing().store, published: true, warned: false, pendingSubmission: false, publishedVersion: '1.0.316.600' } })).toEqual(['E1']);
    expect(runGate({ ...passing(), record: recordOf(other) }).outcome).toBe('abort');
  });

  test('E2: file added to the candidate → abort', () => {
    expect(failed({ ...passing(), candidate: rawCandidate({ 'extra.js': 'x' }) })).toEqual(['E2']);
  });

  test('E3: a file outside rule_resources changed → abort', () => {
    const v = runGate({ ...passing(), candidate: rawCandidate({ 'background.js': 'evil()' }) });
    expect(v.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual(['E3']);
    expect(v.outcome).toBe('abort');
  });

  test('E4: manifest changed beyond the version, or version not later / other code line → abort', () => {
    expect(failed({ ...passing(), candidate: rawCandidate({}, manifestText(NEXT, ',"homepage_url":"https://x.example"')) })).toEqual(['E4']);
    expect(failed({ ...passing(), candidate: rawCandidate({}, manifestText('1.0.317.600')) })).toEqual(['E4']);
    expect(failed({ ...passing(), candidate: rawCandidate({}, manifestText('1.1.318.600')) })).toEqual(['E4']);
  });

  test('E5: a -x file changed → route to the full-release train', () => {
    const v = runGate({ ...passing(), candidate: rawCandidate({ 'rulesets/ubo-x.json': rulesText([redirect(1, 'cdn.example'), redirect(2, 'b.example')]) }) });
    expect(v.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual(['E5']);
    expect(v.outcome).toBe('route-to-full');
  });

  test('E6: an unsafe rule in a safe file, a safe rule turned unsafe, or unreadable rules → abort', () => {
    expect(failed({ ...passing(), candidate: candidateWith([...UBO_RULES, redirect(21, 'n21.example')]) })).toEqual(['E6']);
    const modify = { id: 21, action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x', operation: 'remove' }] }, condition: { urlFilter: 'x' } };
    expect(failed({ ...passing(), candidate: candidateWith([...UBO_RULES, modify]) })).toEqual(['E6']);
    expect(failed({ ...passing(), candidate: rawCandidate({ 'rulesets/ubo.json': '{"not":"rules"}' }) })).toContain('E6');
  });

  test('E7: a key changed id, or a retired id reused → abort', () => {
    const before = ledger('ubo', 20);
    const moved: Ledger = { ...ledger('ubo', 21), entries: { ...ledger('ubo', 21).entries, 'r:00000000000000000001': 22 }, nextId: 23 };
    expect(failed({ ...passing(), ledgers: ledgers(before, moved) })).toEqual(['E7']);
    const reused: Ledger = { ...before, entries: { ...before.entries, 'r:new': 20 } };
    const dropped = Object.fromEntries(Object.entries(before.entries).filter(([, id]) => id !== 20));
    expect(failed({ ...passing(), ledgers: ledgers(before, { ...reused, entries: { ...dropped, 'r:new': 20 } }) })).toEqual(['E7']);
    expect(failed({ ...passing(), ledgers: ledgers(before, undefined) })).toEqual(['E7']);
  });

  test('E8: over the catalog ceiling, too many regex, or an unsupported regex → open a PR', () => {
    const many = Array.from({ length: 101 }, (_, i) => block(i + 1, `m${String(i)}.example`));
    const v = runGate({ ...passing(), candidate: candidateWith(many), ledgers: ledgers(ledger('ubo', 20), ledger('ubo', 101)) });
    expect(v.checks.find((c) => c.id === 'E8')?.pass).toBe(false);
    const re = (id: number, regex: string): object => ({ id, priority: 10, action: { type: 'block' }, condition: { regexFilter: regex } });
    const twoRegex = [...UBO_RULES.slice(2), re(1, '^a'), re(2, '^c'), ADDED];
    expect(failed({ ...passing(), candidate: candidateWith(twoRegex), regexSupported: new Map([[key('^a'), true], [key('^c'), true]]) })).toEqual(['E8']);
    const oneRegex = [...UBO_RULES, { ...re(21, '^b') }];
    expect(failed({ ...passing(), candidate: candidateWith(oneRegex), regexSupported: new Map([[key('^b'), false]]) })).toEqual(['E8']);
    expect(failed({ ...passing(), candidate: candidateWith(oneRegex) })).toEqual(['E8']);
    const ok = runGate({ ...passing(), candidate: candidateWith(oneRegex), regexSupported: new Map([[key('^b'), true]]) });
    expect(ok.outcome).toBe('publish');
    expect(runGate({ ...passing(), candidate: candidateWith(oneRegex) }).outcome).toBe('open-pr');
  });

  test('E8: the default-on total over 24,000 rules → open a PR', () => {
    const catalog = JSON.stringify({ ...JSON.parse(CATALOG) as object, rulesets: { ubo: { maxRules: 30_000, maxRegex: 0 }, easylist: { maxRules: 100, maxRegex: 0 }, 'ubo-x': { maxRules: 10, maxRegex: 0 } } });
    const base = extensionZip({ files: { ...BASE_FILES, 'catalog.json': catalog } });
    const big = Array.from({ length: 24_000 }, (_, i) => block(i + 1, `h${String(i)}.example`));
    const candidate = repack({ base, rulesets: new Map([['rulesets/ubo.json', text(rulesText(big))]]), version: NEXT });
    const v = runGate({ ...passing(), base, record: recordOf(base), candidate, ledgers: { before: new Map(), after: new Map() } });
    expect(v.checks.find((c) => c.id === 'E8')?.problems.join()).toMatch(/24,?000/);
  });

  test('E9: the candidate did not load, or E9 was not run → abort', () => {
    expect(failed({ ...passing(), load: { ok: false, problems: ['ruleset ubo failed to parse'] } })).toEqual(['E9']);
    expect(failed(without(passing(), 'load'))).toEqual(['E9']);
  });

  test('E10: rule count up more than 10 % or bytes more than 25 % → open a PR', () => {
    const grown = [...UBO_RULES, ...Array.from({ length: 3 }, (_, i) => block(21 + i, `g${String(i)}.example`))];
    const v = runGate({ ...passing(), candidate: candidateWith(grown), ledgers: ledgers(ledger('ubo', 20), ledger('ubo', 23)) });
    expect(v.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual(['E10']);
    expect(v.outcome).toBe('open-pr');
    const longHost = [...UBO_RULES.slice(0, 19), block(20, `${'x'.repeat(600)}.example`), ADDED];
    expect(failed({ ...passing(), candidate: candidateWith(longHost) })).toEqual(['E10']);
  });

  test('E11: item not published, warned, a pending submission, or state unknown → skip this run', () => {
    const s = { published: true, publishedVersion: '1.0.317.600', warned: false, pendingSubmission: false };
    expect(runGate({ ...passing(), store: { ...s, pendingSubmission: true } }).outcome).toBe('skip');
    expect(failed({ ...passing(), store: { ...s, warned: true } })).toEqual(['E11']);
    expect(failed({ ...passing(), store: { ...s, published: false } })).toEqual(['E11']);
    expect(failed(without(passing(), 'store'))).toEqual(['E11']);
  });

  test('outcome order: abort beats route-to-full beats open-pr beats skip', () => {
    const all = { ...without(passing(), 'store'), candidate: rawCandidate({ 'background.js': 'evil()', 'rulesets/ubo-x.json': '[]' }) };
    expect(runGate(all).outcome).toBe('abort');
    expect(runGate({ ...without(passing(), 'store'), candidate: rawCandidate({ 'rulesets/ubo-x.json': '[]' }) }).outcome).toBe('route-to-full');
  });
});


describe('gate edge cases', () => {
  test('an unreadable zip aborts at once', () => {
    expect(runGate({ ...passing(), candidate: text('not a zip, not a zip, not a zip') })).toMatchObject({ outcome: 'abort', checks: [{ id: 'E1', pass: false }] });
  });

  test('a failed load without details still fails E9', () => {
    expect(runGate({ ...passing(), load: { ok: false, problems: [] } }).checks.find((c) => c.id === 'E9')?.problems).toEqual(['load failed']);
  });

  test('E6 / E8 / E10 report a ruleset that is not JSON, in the base or the candidate', () => {
    const broken = rawCandidate({ 'rulesets/ubo.json': '[{' });
    const v = runGate({ ...passing(), candidate: broken });
    expect(v.checks.find((c) => c.id === 'E6')?.problems.join()).toMatch(/ubo\.json/);
    expect(v.checks.find((c) => c.id === 'E8')?.pass).toBe(false);
    const badBase = extensionZip({ files: { ...BASE_FILES, 'rulesets/ubo.json': '[{' } });
    expect(runGate({ ...passing(), base: badBase, record: recordOf(badBase) }).checks.find((c) => c.id === 'E6')?.pass).toBe(false);
  });

  test('E8 needs readable ceilings for every ruleset', () => {
    const without = (files: Record<string, string>): string[] => [...runGate({ ...passing(), candidate: rawCandidate(files) }).checks.find((c) => c.id === 'E8')?.problems ?? []];
    const noCatalog = Object.fromEntries(Object.entries(BASE_FILES).filter(([p]) => p !== 'catalog.json'));
    const missing = extensionZip({ manifest: manifestText(NEXT), files: { ...noCatalog, 'rulesets/ubo.json': rulesText([...UBO_RULES, ADDED]) } });
    expect(runGate({ ...passing(), candidate: missing }).checks.find((c) => c.id === 'E8')?.problems).toEqual(['candidate has no catalog.json']);
    expect(without({ 'catalog.json': '{"rulesets":1}' })).toEqual(['catalog.json has no readable ceilings']);
    expect(without({ 'catalog.json': '{"rulesets":{"ubo":{"maxRules":100,"maxRegex":0}}}' }).join()).toMatch(/easylist: no ceiling/);
  });

  test('E10 counts a ruleset that was empty and now has rules as growth', () => {
    const base = extensionZip({ files: { ...BASE_FILES, 'rulesets/easylist.json': '[]' } });
    const candidate = repack({ base, rulesets: new Map([['rulesets/easylist.json', text(rulesText([block(1, 'a.example')]))]]), version: NEXT });
    const v = runGate({ ...passing(), base, record: recordOf(base), candidate, ledgers: { before: new Map(), after: new Map() } });
    expect(v.checks.find((c) => c.id === 'E10')?.problems.join()).toMatch(/easylist: rule count 0 → 1/);
  });

  test('E7 refuses a ledger whose nextId went down', () => {
    const before = ledger('ubo', 20);
    expect(failed({ ...passing(), ledgers: ledgers(before, { ...before, nextId: 5 }) })).toEqual(['E7']);
  });
});


describe('gate bypasses closed by the security review', () => {
  test('E7: a slot with rules but no ledger of the published release fails (no comparing nothing)', () => {
    expect(failed({ ...passing(), ledgers: { before: new Map(), after: new Map() } })).toEqual(['E7']);
  });

  test('E4: a duplicate-key or reformatted manifest fails even when it parses the same', () => {
    const dup = manifestText(NEXT, ',"permissions":["tabs"]');
    expect(failed({ ...passing(), candidate: rawCandidate({}, dup) })).toEqual(['E4']);
    const spaced = manifestText(NEXT).replace('"name":"Glassmere"', '"name": "Glassmere"');
    expect(failed({ ...passing(), candidate: rawCandidate({}, spaced) })).toEqual(['E4']);
  });

  test('E6: an unsafe rule hidden behind a safe one with the same id, or a duplicate JSON key, fails', () => {
    const hidden = `[${[...UBO_RULES, ADDED].map((r) => JSON.stringify(r)).join(',')},${JSON.stringify(redirect(21, 'x.example'))}]`;
    expect(failed({ ...passing(), candidate: rawCandidate({ 'rulesets/ubo.json': hidden }) })).toContain('E6');
    const dupKey = rulesText([...UBO_RULES, ADDED]).replace('{"type":"block"}', '{"type":"redirect","type":"block"}');
    expect(runGate({ ...passing(), candidate: rawCandidate({ 'rulesets/ubo.json': dupKey }) }).checks.find((c) => c.id === 'E6')?.problems.join()).toMatch(/canonical/);
  });

  test('E8: a catalog that is not JSON is a finding, not a crash', () => {
    expect(runGate({ ...passing(), candidate: rawCandidate({ 'catalog.json': '{' }) }).checks.find((c) => c.id === 'E8')?.problems).toContain('catalog.json is not readable JSON');
  });
});

function key(regex: string): string {
  return queryKey({ regex, isCaseSensitive: false, requireCapturing: false });
}
