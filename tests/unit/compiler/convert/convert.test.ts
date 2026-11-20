import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { convertRuleset, sourceMapOf } from '../../../../compiler/convert/convert.js';
import { reasonOfConverterError } from '../../../../compiler/convert/errors.js';
import { applyPatches } from '../../../../compiler/convert/patches.js';
import { withAcceptAllRegex } from '../../../../compiler/convert/regex-gate.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { collectBadfilters } from '../../../../compiler/normalise/badfilter.js';
import { normaliseRuleset, type ConverterInput } from '../../../../compiler/normalise/normalise.js';
import { classify } from '../../../../compiler/parse/classify.js';

interface GoldenCase {
  readonly name: string;
  readonly in: readonly string[];
  readonly rules: readonly Record<string, unknown>[];
  readonly log: readonly (readonly [number, string])[];
}
const GOLDEN = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../golden/compiler/convert.json'), 'utf8'),
) as { cases: GoldenCase[] };

async function run(lines: readonly string[]) {
  const entries = lines.map((text, i) => ({ ...classify(text), source: { list: 'l', line: i + 1, text }, trusted: true }));
  const n = normaliseRuleset(entries, collectBadfilters(entries));
  return convertRuleset(n.inputs);
}

describe('convert (golden, end to end through the normaliser)', () => {
  test.each(GOLDEN.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const r = await run(c.in);
    const rules = r.rules.map(({ rule, sources }) => {
      const withoutId = Object.fromEntries(Object.entries(rule).filter(([k]) => k !== 'id'));
      return { ...withoutId, from: sources.map((s) => s.source.line) };
    });
    expect(rules).toEqual(c.rules);
    expect(r.log.map((l) => [l.source.line, l.reason])).toEqual(c.log);
  });

  test('is deterministic and keeps a source map per rule', async () => {
    const lines = ['||a.example^', '||b.example^$script', '@@||a.example^$image'];
    const [one, two] = [await run(lines), await run(lines)];
    expect(JSON.stringify(one.rules.map((r) => r.rule))).toBe(JSON.stringify(two.rules.map((r) => r.rule)));
    expect(sourceMapOf(one.rules)).toEqual([[{ list: 'l', line: 1, text: '||a.example^' }],
      [{ list: 'l', line: 2, text: '||b.example^$script' }], [{ list: 'l', line: 3, text: '@@||a.example^$image' }]]);
  });

  test('records every regex for the Chromium gate and restores the global it borrows', async () => {
    const before = (globalThis as { chrome?: unknown }).chrome;
    const r = await run(['/ad[0-9]+\\.js/$script']);
    expect(r.regexes).toEqual(['ad[0-9]+\\.js']);
    expect((globalThis as { chrome?: unknown }).chrome).toBe(before);
  });

  test('an empty ruleset converts to nothing', async () => {
    expect(await convertRuleset([])).toEqual({ rules: [], log: [], regexes: [] });
  });
});

describe('converter error reasons', () => {
  test.each([
    [{ message: 'Network allowlist rule with $csp modifier cannot be resolved safely' }, 'csp-allow-unresolved'],
    [{ message: '"$header is not compatible with $method" in the rule: "x"' }, 'header-with-method'],
    [{ message: 'Unknown modifier: 2/' }, 'converter-misparse'],
    [{ name: 'RuleScanError', message: '"Rule has spaces, seems to be a host rule" in the rule: "/a[^ ]/$script"' }, 'converter-misparse'],
    [{ message: 'Unknown modifier: foo' }, 'unsupported-modifier'],
    [{ name: 'EmptyDomainsError', message: 'domains are empty' }, 'empty-domains'],
    [{ name: 'EmptyResourcesError', message: 'types cancel' }, 'empty-resource-types'],
    [{ name: 'InvalidDeclarativeRuleError', message: 'bad rule' }, 'invalid-declarative-rule'],
  ])('%j → %s', (e, reason) => {
    expect(reasonOfConverterError(e)).toBe(reason);
  });

  test('an error nobody classified fails the build', () => {
    expect(() => reasonOfConverterError({ name: 'NewError', message: 'something new' })).toThrow(/unknown rejection reason/);
  });
});

describe('patches', () => {
  const rule: DnrRule = { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||x^', resourceTypes: ['script'] } };
  const src = (extra: Partial<ConverterInput>): ConverterInput => ({ text: '||x^', source: { list: 'l', line: 1, text: 't' }, fixes: [], ...extra });

  test('sources that disagree leave the rule unpatched and report the conflict', () => {
    const r = applyPatches(rule, [src({ docTypes: 'only' }), src({})]);
    expect(r.rule).toBe(rule);
    expect(r.conflicts).toEqual(['docTypes']);
  });

  test('add keeps the other types; uritransform needs a regex condition', () => {
    expect(applyPatches(rule, [src({ docTypes: 'add' })]).rule.condition.resourceTypes).toEqual(['script', 'main_frame']);
    expect(applyPatches(rule, [src({ uritransform: '\\1' })]).rule.action).toEqual({ type: 'block' });
  });

  test('add on a rule without a type list covers every type; uritransform never rewrites an allow', () => {
    const untyped: DnrRule = { id: 1, action: { type: 'block' }, condition: { urlFilter: '||x^' } };
    expect(applyPatches(untyped, [src({ docTypes: 'add' })]).rule.condition.resourceTypes).toContain('main_frame');
    expect(applyPatches(untyped, [src({ docTypes: 'add' })]).rule.condition.resourceTypes).toContain('script');
    const allow: DnrRule = { id: 1, action: { type: 'allow' }, condition: { regexFilter: 'x' } };
    expect(applyPatches(allow, [src({ uritransform: '\\1' })]).rule.action).toEqual({ type: 'allow' });
  });

  test('top with only exclusions sets only excludedTopDomains', () => {
    const r = applyPatches(rule, [src({ top: { include: [], exclude: ['b.example', 'a.example'] } })]);
    expect(r.rule.condition).toEqual({ ...rule.condition, excludedTopDomains: ['a.example', 'b.example'] });
  });
});

describe('regex gate', () => {
  test('restores the previous global even when the conversion throws, and serialises calls', async () => {
    const g = globalThis as { chrome?: unknown };
    const marker = { marker: true };
    g.chrome = marker;
    await expect(withAcceptAllRegex(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(g.chrome).toBe(marker);
    const order: number[] = [];
    await Promise.all([1, 2].map((n) => withAcceptAllRegex(async () => { order.push(n); await Promise.resolve(); order.push(n); })));
    expect(order).toEqual([1, 1, 2, 2]);
    delete g.chrome;
  });
});
