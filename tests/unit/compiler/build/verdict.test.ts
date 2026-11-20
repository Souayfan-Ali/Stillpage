/**
 * D-40 (design review 2026-11-14, amends update-strategy notes §3.3): a build whose only failures are count-oracle rows exits 4
 * ("open or update a PR for a human"), still publishing nothing; any other failure exits 1; growth with
 * `--fail-on-growth` stays 3.
 */
import { describe, expect, test } from 'vitest';
import { EXIT, buildVerdict, ORACLE_FAILURE_PREFIX } from '../../../../compiler/build/verdict.js';

describe('lists:build verdict', () => {
  test('clean → publish; growth with --fail-on-growth → 3', () => {
    expect(buildVerdict([], { growth: false, failOnGrowth: true })).toEqual({ exit: EXIT.ok, writeOutputs: true });
    expect(buildVerdict([], { growth: true, failOnGrowth: true })).toEqual({ exit: EXIT.growth, writeOutputs: true });
    expect(buildVerdict([], { growth: true, failOnGrowth: false })).toEqual({ exit: EXIT.ok, writeOutputs: true });
  });

  test('only oracle failures → 4, nothing written', () => {
    expect(buildVerdict([`${ORACLE_FAILURE_PREFIX}ubo regex`], { growth: true, failOnGrowth: true })).toEqual({ exit: EXIT.oracle, writeOutputs: false });
    expect(EXIT).toEqual({ ok: 0, failure: 1, growth: 3, oracle: 4 });
  });

  test('any other failure → 1, nothing written, also beside oracle failures', () => {
    expect(buildVerdict(['regex over budget', `${ORACLE_FAILURE_PREFIX}ubo regex`], { growth: false, failOnGrowth: false })).toEqual({ exit: EXIT.failure, writeOutputs: false });
  });
});
