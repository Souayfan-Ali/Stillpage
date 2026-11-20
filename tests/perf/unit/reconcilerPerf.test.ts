import { describe, expect, test } from 'vitest';
import type { RulesetId } from '../../../src/core/ids.js';
import { createReconciler } from '../../../src/background/reconciler.js';
import { createFakeBrowser } from '../../unit/platform/fakes/browser.js';
import { NOW, toCatalog } from '../../unit/core/reconcile/fixtures.js';

/** Full-scale registration set (performance notes §2.3): 600 registrations, 36,000 patterns. */
const REGISTRATIONS = 600;
const HOSTS_PER_REGISTRATION = 60;
const RUNS = 20;
/** performance notes §2.2 / ADR-012: a no-op wake ≤ 150 ms p95 (our share; Chrome's calls are faked here). */
const NO_OP_BUDGET_MS = 150;
/** performance notes §2.2: reconciled after an update ≤ 1,000 ms p95. */
const UPDATE_BUDGET_MS = 1_000;

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

const p95 = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? Infinity;

describe('reconciler budgets with the full registration set', () => {
  test('no-op wake and re-registration after an update stay within budget', async () => {
    // Arrange
    const rulesets = [
      { id: 'ubo' as RulesetId, enabled: true, regexCount: 1 },
      { id: 'ubo-x' as RulesetId, enabled: false, regexCount: 1 },
    ];
    const b = createFakeBrowser({ rulesets, catalog: fullCatalog(), now: () => NOW });
    const reconciler = createReconciler(b.ports);
    await reconciler.request('install');

    // Act
    const noOp: number[] = [];
    const update: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = performance.now();
      expect((await reconciler.request('wake')).status).toBe('unchanged');
      noOp.push(performance.now() - t0);
    }
    for (let i = 0; i < RUNS / 4; i += 1) {
      b.simulateUpdate();
      const t0 = performance.now();
      expect((await reconciler.request('update')).status).toBe('applied');
      update.push(performance.now() - t0);
    }

    // Assert
    expect(p95(noOp)).toBeLessThan(NO_OP_BUDGET_MS);
    expect(p95(update)).toBeLessThan(UPDATE_BUDGET_MS);
    expect((await b.ports.scripting.getRegisteredContentScripts()).length).toBe(REGISTRATIONS);
  });
});
