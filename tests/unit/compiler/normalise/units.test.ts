import type { NetworkRule } from '@adguard/agtree';
import { describe, expect, test } from 'vitest';
import { filterKey } from '../../../../compiler/normalise/badfilter.js';
import { withMods, withoutMods } from '../../../../compiler/normalise/modifiers.js';
import { normaliseNetwork, withoutPopup } from '../../../../compiler/normalise/normalise.js';
import { assertReason, isReasonCode, REASONS } from '../../../../compiler/normalise/reasons.js';
import { optionAnchorFix, runSteps } from '../../../../compiler/normalise/transforms.js';
import { parseLine } from '../../../../compiler/parse/classify.js';

const net = (text: string): NetworkRule => {
  const n = parseLine(text);
  if (n.category !== 'Network' || n.type !== 'NetworkRule') throw new Error(`not a network rule: ${text}`);
  return n;
};
const SRC = { list: 'l', line: 1, text: 't' };

describe('reason codes', () => {
  test('an unknown reason fails loudly; known ones pass', () => {
    expect(() => assertReason('mystery')).toThrow(/unknown rejection reason "mystery"/);
    expect(assertReason('badfilter')).toBe('badfilter');
    expect(isReasonCode('toString')).toBe(false);
  });

  test('every reason says whether uBOL loses the filter too', () => {
    for (const r of Object.values(REASONS)) expect(typeof r.ubolAlso).toBe('boolean');
  });
});

describe('modifier helpers and edge paths', () => {
  test('removing the last modifier removes the option list', () => {
    expect('modifiers' in withoutMods(net('||x.example^$script'), 'script')).toBe(false);
    expect(withMods(net('||x.example^'), []).pattern.value).toBe('||x.example^');
  });

  test('badfilter keys ignore option order and the badfilter option', () => {
    expect(filterKey(net('||x^$script,3p,badfilter'))).toBe(filterKey(net('||x^$3p,script')));
    expect(filterKey(net('@@||x^$script'))).not.toBe(filterKey(net('||x^$script')));
    expect(filterKey(net('||x^$~script'))).not.toBe(filterKey(net('||x^$script')));
  });

  test('option-anchor leaves well-formed filters and unrecoverable ones alone', () => {
    const ok = { node: net('/ab$cd/$script'), fixes: [] };
    expect(optionAnchorFix(ok)).toBe(ok);
    const bogus = { node: net('||x^$2nd'), fixes: [] };
    expect(optionAnchorFix(bogus)).toBe(bogus);
  });

  test('a filter with no options passes every step unchanged', () => {
    const start = { node: net('||plain.example^'), fixes: [] };
    expect(runSteps(start)).toEqual(start);
  });

  test('withoutPopup is undefined without other types; agtree failures are logged', () => {
    expect(withoutPopup(net('||p.example^$popup,3p'))).toBeUndefined();
    const outcome = normaliseNetwork(net('||x.example^$script'), SRC);
    expect('inputs' in outcome && outcome.inputs[0]?.text).toBe('||x.example^$script');
  });
});
