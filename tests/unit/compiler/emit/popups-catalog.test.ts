/** P1-50: the `popups` ruleset is in the catalog, on by default, and enabled by the reconciler without host access. */
import { describe, expect, test } from 'vitest';
import { loadListsConfig } from '../../../../compiler/config/load.js';
import { catalogOf } from '../../../../compiler/emit/catalog.js';
import { manifestFragment } from '../../../../compiler/emit/emit.js';
import { slotsOf } from '../../../../compiler/postpass/budgets.js';
import { readCatalog } from '../../../../src/core/catalog/read.js';
import { computeDesired } from '../../../../src/core/reconcile/computeDesired.js';
import { GRANTS, NOW, settings } from '../../core/reconcile/fixtures.js';

const CONFIG = new URL('../../../../lists/lists.config.json', import.meta.url).pathname;

describe('popups ruleset in catalog, manifest and reconciler (P1-50)', () => {
  test('listed in a default pack, safe, with its own ceiling, and on in the manifest', async () => {
    const config = await loadListsConfig(CONFIG);
    const slots = slotsOf(config);
    const read = readCatalog(catalogOf(config, slots));
    if (!read.ok) throw new Error(read.errors.join('; '));
    expect(read.value.rulesets['popups' as never]).toEqual({ needsHostAccess: false, maxRules: 530, maxRegex: 5 });
    expect(read.value.packs['popups' as never]).toMatchObject({ rulesets: ['popups'], default: true });
    const fragment = manifestFragment(slots) as { declarative_net_request: { rule_resources: { id: string; enabled: boolean }[] } };
    expect(fragment.declarative_net_request.rule_resources.find((r) => r.id === 'popups')).toMatchObject({ enabled: true });
  });

  test.each(Object.entries(GRANTS))('computeDesired enables popups with %s access', async (_name, grants) => {
    const config = await loadListsConfig(CONFIG);
    const read = readCatalog(catalogOf(config, slotsOf(config)));
    if (!read.ok) throw new Error(read.errors.join('; '));
    expect(computeDesired(settings(), grants, read.value, NOW).enabledRulesets).toContain('popups');
  });
});
