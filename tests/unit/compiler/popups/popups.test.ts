import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NetworkRule } from '@adguard/agtree';
import { describe, expect, test } from 'vitest';
import { stemIndex } from '../../../../compiler/entities/expand.js';
import { parseLine } from '../../../../compiler/parse/classify.js';
import { buildPopups, uncoveredDestinations } from '../../../../compiler/popups/emit.js';
import { popupOutcome } from '../../../../compiler/popups/shapes.js';
import { classify } from '../../../../compiler/parse/classify.js';
import { POPUP_PRIORITY } from '../../../../src/core/limits.js';

interface Case { readonly shape: string; readonly in: string; readonly rule?: unknown; readonly destination?: string; readonly strict?: string[]; readonly log?: [string, string] }
const GOLDEN = (JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../golden/compiler/popups.json'), 'utf8')) as { cases: Case[] }).cases;
const STEMS = stemIndex(['movies.de', 'movies.co.uk', 'www.movies.com']);
const node = (text: string): NetworkRule => parseLine(text) as NetworkRule;
const entries = (lines: readonly string[]) => lines.map((text, i) => ({ ...classify(text), source: { list: 'l', line: i + 1, text }, trusted: true }));

describe('pop-up filter shapes (golden, filter-pipeline notes §7a)', () => {
  test.each(GOLDEN.map((c) => [c.shape, c] as const))('%s', (_name, c) => {
    const o = popupOutcome(node(c.in), STEMS);
    if (c.rule !== undefined) {
      expect(o.kind).toBe('rule');
      if (o.kind !== 'rule') return;
      expect(Object.fromEntries(Object.entries(o.rule).filter(([k]) => k !== 'id'))).toEqual(c.rule);
      expect(o.destination).toBe(c.destination);
    } else if (c.strict !== undefined) {
      expect(o).toMatchObject({ kind: 'strict', sites: c.strict });
    } else {
      expect(o).toEqual({ kind: 'log', reason: c.log?.[0], detail: c.log?.[1] });
    }
  });
});

describe('buildPopups (P1-49)', () => {
  const lines = ['||a.popads.example^$popup', '||popads.example^$popup', '||b.example^$popup', '||c.example/p$popup', '@@||ok.example^$popup',
    '||ctx.example^$popup,domain=s.example', '*$popup,3p,domain=strict.example', '/generic?$popup', '||b.example^$popup'];
  const build = () => buildPopups(entries(lines), STEMS, (h) => (h.endsWith('popads.example') ? 'popads' : undefined));

  test('every filter lands in exactly one of rule, strict list, log', () => {
    const b = build();
    expect(b.accounting).toEqual({ filters: 9, rule: 7, strict: 1, log: 1 });
    expect(b.log.map((l) => l.reason)).toEqual(['popup-generic-pattern']);
    const sourced = new Set(b.rules.flatMap((r) => r.sources.map((s) => s.source.line)));
    expect([...sourced].sort()).toEqual([1, 2, 3, 4, 5, 6, 9]);
  });

  test('only block/allow on main_frame in the pop-up band; destinations ⊆ popups hosts; strict sites', () => {
    const b = build();
    for (const r of b.rules) {
      expect(['block', 'allow']).toContain(r.rule.action.type);
      expect(r.rule.condition.resourceTypes).toEqual(['main_frame']);
      expect(r.rule.priority).toBe(r.rule.action.type === 'block' ? POPUP_PRIORITY.block : POPUP_PRIORITY.allow);
    }
    expect(b.destinations).toEqual(['b.example', 'popads.example']);
    expect(uncoveredDestinations(b.destinations, b.rules)).toEqual([]);
    expect(uncoveredDestinations(['other.example'], b.rules)).toEqual(['other.example']);
    expect(b.strictSites).toEqual(['strict.example']);
    expect(b.rules.find((r) => r.rule.condition.urlFilter === '||popads.example^')?.bucket).toBe('popads');
  });

  test('deterministic', () => {
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});
