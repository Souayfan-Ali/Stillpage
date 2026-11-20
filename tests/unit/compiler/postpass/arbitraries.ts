/** fast-check generators for DNR rules (compiler post-pass property tests). */
import fc from 'fast-check';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';

const DOMAINS = ['a.example', 'b.example', 'c.example', 'd.example', 'x.a.example'];
const TYPES = ['script', 'image', 'xmlhttprequest', 'sub_frame', 'main_frame'] as const;
const domains = fc.uniqueArray(fc.constantFrom(...DOMAINS), { minLength: 1, maxLength: 4 });

const arbCondition = fc.record(
  {
    urlFilter: fc.constantFrom('||ads.example^', '/banner/', '||t.example/px'),
    requestDomains: domains,
    initiatorDomains: domains,
    excludedInitiatorDomains: domains,
    resourceTypes: fc.uniqueArray(fc.constantFrom(...TYPES), { minLength: 1, maxLength: 3 }),
    domainType: fc.constantFrom('firstParty' as const, 'thirdParty' as const),
    isUrlFilterCaseSensitive: fc.boolean(),
  },
  { requiredKeys: [] },
);

const arbAction = fc.oneof(
  fc.constant({ type: 'block' as const }),
  fc.constant({ type: 'allow' as const }),
  fc.constant({ type: 'redirect' as const, redirect: { extensionPath: '/surrogates/noop.js' } }),
);

export const arbRule: fc.Arbitrary<DnrRule> = fc.record({
  id: fc.integer({ min: 1, max: 1_000_000 }),
  priority: fc.integer({ min: 1, max: 300 }),
  action: arbAction,
  condition: arbCondition,
});

/** A rule with its set-like arrays shuffled and repeated: same meaning, different bytes. */
export const scrambled = (r: DnrRule): DnrRule => {
  const c = r.condition;
  const twice = <T>(xs: readonly T[] | undefined): T[] | undefined => (xs ? [...xs].reverse().concat(xs) : undefined);
  const cond = Object.fromEntries(Object.entries({
    ...c,
    requestDomains: twice(c.requestDomains),
    initiatorDomains: twice(c.initiatorDomains),
    resourceTypes: twice(c.resourceTypes),
  }).filter(([, v]) => v !== undefined).reverse());
  return { condition: cond, action: r.action, priority: r.priority, id: r.id + 1 };
};
