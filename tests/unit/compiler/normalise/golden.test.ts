import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { collectBadfilters } from '../../../../compiler/normalise/badfilter.js';
import { normaliseRuleset } from '../../../../compiler/normalise/normalise.js';
import { FIXES } from '../../../../compiler/normalise/reasons.js';
import { classify } from '../../../../compiler/parse/classify.js';
import { parseList, type Entry } from '../../../../compiler/parse/parse-list.js';

interface GoldenCase {
  readonly transform: string;
  readonly in: readonly string[];
  readonly format?: 'hosts';
  readonly out?: readonly Record<string, unknown>[];
  readonly log?: readonly string[];
  readonly popups?: number;
  readonly rest?: number;
}

const GOLDEN = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../golden/compiler/normalise.json'), 'utf8'),
) as { cases: GoldenCase[] };

/** `list:text` puts a line in a named list (cross-list cases); otherwise list `l`. */
function entriesOf(c: GoldenCase): Entry[] {
  if (c.format === 'hosts') {
    return [...parseList({ id: 'h', title: 'H', url: 'https://h.example/', licence: 'CC0-1.0', licenceState: 'cleared',
      trusted: false, format: 'hosts', homepage: 'https://h.example/' }, c.in.join('\n')).entries];
  }
  return c.in.map((raw, i) => {
    const m = /^([a-z-]+):(.*)$/.exec(raw);
    const [list, text] = m && !raw.startsWith('||') ? [m[1] ?? 'l', m[2] ?? ''] : ['l', raw];
    return { ...classify(text), source: { list, line: i + 1, text }, trusted: true };
  });
}

describe('uBO-dialect normaliser (golden, one case per transform)', () => {
  test.each(GOLDEN.cases.map((c) => [c.transform, c] as const))('%s', (_name, c) => {
    const entries = entriesOf(c);
    const r = normaliseRuleset(entries, collectBadfilters(entries));
    const out = r.inputs.map((input) => Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'source')));
    expect(out).toEqual(c.out ?? []);
    expect(r.log.map((l) => l.reason)).toEqual(c.log ?? []);
    expect(r.popups).toHaveLength(c.popups ?? 0);
    expect(r.rest).toHaveLength(c.rest ?? 0);
  });

  test('every fix code has a golden case', () => {
    const covered = new Set(GOLDEN.cases.flatMap((c) => (c.out ?? []).flatMap((o) => o['fixes'] as string[])));
    for (const fix of FIXES) expect(covered, fix).toContain(fix);
  });

  test('the parsed input is not mutated', () => {
    const entries = entriesOf({ transform: 'x', in: ['||x.example^$script,from=a.example,reason=r,top=t.example'] });
    const before = JSON.stringify(entries);
    normaliseRuleset(entries, collectBadfilters(entries));
    expect(JSON.stringify(entries)).toBe(before);
  });

  test('log entries keep the source position', () => {
    const entries = entriesOf({ transform: 'x', in: ['||a.example^', '*$script,redirect-rule=noopjs'] });
    const r = normaliseRuleset(entries, new Set());
    expect(r.log[0]?.source).toEqual({ list: 'l', line: 2, text: '*$script,redirect-rule=noopjs' });
  });
});
