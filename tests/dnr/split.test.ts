import { afterAll, describe, expect, test } from 'vitest';
import { withRulesetExtension, type RulesetFile } from '../../compiler/chromium/node-ports.js';
import { compileLines, expectNoSurvivors } from './helpers.js';

interface Outcome { readonly rulesetId: string; readonly ruleId: number }
interface Dnr {
  readonly testMatchOutcome: (r: { url: string; type: string; initiator?: string; tabId: number }) => Promise<{ matchedRules: Outcome[] }>;
  readonly updateEnabledRulesets: (o: { disableRulesetIds: string[] }) => Promise<void>;
}
interface Global { readonly chrome: { readonly declarativeNetRequest: Dnr } }

describe('safe / unsafe split in Chromium (P1-22)', () => {
  afterAll(() => { expectNoSurvivors(); });

  test('an exception in the safe file beats a redirect in -x; with -x off the block applies', async () => {
    const { safe, unsafe } = await compileLines(['||ads.example/ad.js$script,redirect=noopjs', '@@||ads.example/ad.js$script,domain=ok.example']);
    const files: RulesetFile[] = [
      { id: 'ubo', rules: safe.map((r, i) => ({ ...r.rule, id: i + 1 })) },
      { id: 'ubo-x', rules: unsafe.map((r, i) => ({ ...r.rule, id: i + 1 })) },
    ];
    const kindOf = (o: Outcome[]): string[] => o.map((m) => {
      const f = files.find((x) => x.id === m.rulesetId);
      return `${m.rulesetId}:${f?.rules.find((r) => r.id === m.ruleId)?.action.type ?? '?'}`;
    });
    const outcomes = await withRulesetExtension(files, (worker) => worker.evaluate(async () => {
      const d = (globalThis as unknown as Global).chrome.declarativeNetRequest;
      const ask = (initiator: string) => d.testMatchOutcome({ url: 'https://ads.example/ad.js', type: 'script', initiator, tabId: -1 })
        .then((r) => r.matchedRules);
      const allowed = await ask('https://ok.example');
      const redirected = await ask('https://news.example');
      await d.updateEnabledRulesets({ disableRulesetIds: ['ubo-x'] });
      const blockedOnly = await ask('https://news.example');
      const allowedOnly = await ask('https://ok.example');
      return { allowed, redirected, blockedOnly, allowedOnly };
    }));
    expect(kindOf(outcomes.allowed)).toEqual(['ubo:allow']);
    expect(kindOf(outcomes.redirected)).toEqual(['ubo-x:redirect']);
    expect(kindOf(outcomes.blockedOnly)).toEqual(['ubo:block']);
    expect(kindOf(outcomes.allowedOnly)).toEqual(['ubo:allow']);
  });
});
