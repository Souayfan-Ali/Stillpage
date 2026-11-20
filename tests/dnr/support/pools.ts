/**
 * The two regex pools (S-07, D-15) measured on a throwaway extension: static regex rules count
 * against 1,000 over the **enabled** rulesets (Chrome refuses an enabled set above it), and dynamic
 * plus session regex rules share a separate pool of 1,000.
 */
import type { Worker } from '@playwright/test';
import type { TestRuleset } from './launch.js';

const REGEX_POOL = 1_000;
const BIG = 600;
const SMALL = REGEX_POOL - BIG;

const regexRules = (count: number, tag: string, firstId = 1): object[] =>
  Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    priority: 1,
    action: { type: 'block' },
    condition: { regexFilter: `^https://${tag}${String(i)}\\.test/x[0-9]+` },
  }));

/** Three regex rulesets, all declared off: 600, 600 and 400 rules. */
export function poolRulesets(): readonly TestRuleset[] {
  return [
    { id: 'ra', rules: regexRules(BIG, 'ra'), enabled: false },
    { id: 'rb', rules: regexRules(BIG, 'rb'), enabled: false },
    { id: 'rc', rules: regexRules(SMALL, 'rc'), enabled: false },
  ];
}

export interface PoolResults {
  readonly staticOverLimit: 'rejected' | 'enabled';
  readonly staticAtLimit: 'rejected' | 'enabled';
  readonly dynamicAndSessionBesideFullStatic: 'rejected' | 'accepted';
  readonly sharedPoolOverLimit: 'rejected' | 'accepted';
}

interface PoolDnr {
  updateEnabledRulesets(o: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }): Promise<void>;
  updateDynamicRules(o: { addRules: object[] }): Promise<void>;
  updateSessionRules(o: { addRules: object[] }): Promise<void>;
}

export function measurePools(worker: Worker): Promise<PoolResults> {
  const dynamic = regexRules(BIG, 'dy');
  const session = regexRules(SMALL, 'se');
  const extra = regexRules(1, 'ex', SMALL + 1);
  return worker.evaluate(
    async ([dyn, ses, one]) => {
      const d = (globalThis as unknown as { chrome: { declarativeNetRequest: PoolDnr } }).chrome.declarativeNetRequest;
      const attempt = (p: Promise<void>): Promise<boolean> => p.then(() => true, () => false);
      const over = await attempt(d.updateEnabledRulesets({ enableRulesetIds: ['ra', 'rb'] }));
      const at = await attempt(d.updateEnabledRulesets({ disableRulesetIds: ['rb'], enableRulesetIds: ['ra', 'rc'] }));
      const beside = (await attempt(d.updateDynamicRules({ addRules: dyn }))) && (await attempt(d.updateSessionRules({ addRules: ses })));
      const shared = await attempt(d.updateSessionRules({ addRules: one }));
      return {
        staticOverLimit: over ? 'enabled' : 'rejected',
        staticAtLimit: at ? 'enabled' : 'rejected',
        dynamicAndSessionBesideFullStatic: beside ? 'accepted' : 'rejected',
        sharedPoolOverLimit: shared ? 'accepted' : 'rejected',
      } as const;
    },
    [dynamic, session, extra] as const,
  );
}
