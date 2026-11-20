import { describe, expect, test } from 'vitest';
import type { RulesetId } from '../../../src/core/ids.js';
import { createReconciler } from '../../../src/background/reconciler.js';
import { createFakeBrowser } from '../platform/fakes/browser.js';
import { NOW, toCatalog } from '../core/reconcile/fixtures.js';

/**
 * Correctness with the full registration set (performance notes §2.3: 600 registrations, 36,000 patterns). The
 * timing budgets of the same runs are in `tests/perf/unit/reconcilerPerf.test.ts` (`npm run test:perf`).
 */
const REGISTRATIONS = 600;
const HOSTS_PER_REGISTRATION = 60;

function fullCatalog(): ReturnType<typeof toCatalog> {
  const registrations = Array.from({ length: REGISTRATIONS }, (_, r) => ({
    id: `${r % 2 === 0 ? 'iso' : 'main'}:ads:${String(r)}`,
    world: r % 2 === 0 ? 'ISOLATED' : 'MAIN',
    js: [`cs/ads/${String(r)}.js`],
    hosts: Array.from({ length: HOSTS_PER_REGISTRATION }, (_, h) => `h${String(h)}-r${String(r)}.example`),
  }));
  return toCatalog({
    schema: 1,
    rulesets: { ubo: { needsHostAccess: false, maxRules: 1, maxRegex: 1 }, 'ubo-x': { needsHostAccess: true, maxRules: 1, maxRegex: 1 } },
    packs: { ads: { rulesets: ['ubo', 'ubo-x'], default: true, licence: 'cleared', registrations } },
  });
}

describe('reconciler with the full registration set', () => {
  test(
    'a wake after install changes nothing; an update re-registers everything',
    async () => {
      const rulesets = [
        { id: 'ubo' as RulesetId, enabled: true, regexCount: 1 },
        { id: 'ubo-x' as RulesetId, enabled: false, regexCount: 1 },
      ];
      const b = createFakeBrowser({ rulesets, catalog: fullCatalog(), now: () => NOW });
      const reconciler = createReconciler(b.ports);
      expect((await reconciler.request('install')).status).toBe('applied');

      expect((await reconciler.request('wake')).status).toBe('unchanged');
      b.simulateUpdate();
      expect((await reconciler.request('update')).status).toBe('applied');
      expect((await b.ports.scripting.getRegisteredContentScripts()).length).toBe(REGISTRATIONS);
    },
  );
});
