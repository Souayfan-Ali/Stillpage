import { describe, expect, test } from 'vitest';
import type { RulesetId } from '../../../src/core/ids.js';
import type { DnrRule, ScriptRegistration } from '../../../src/core/reconcile/types.js';
import { createFakeBrowser } from './fakes/browser.js';

const rid = (id: string): RulesetId => id as RulesetId;

function block(id: number, regex = false): DnrRule {
  return {
    id,
    priority: 1,
    action: { type: 'block' },
    condition: regex ? { regexFilter: `^https://r${String(id)}\\.test/` } : { requestDomains: [`b${String(id)}.test`] },
  };
}

function script(id: string, matches: readonly string[] = ['*://*.a.test/*']): ScriptRegistration {
  return {
    id,
    world: 'ISOLATED',
    js: ['content/x.js'],
    matches,
    excludeMatches: [],
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
  };
}

const MANIFEST = [
  { id: rid('ubo'), enabled: true, regexCount: 270 },
  { id: rid('ubo-x'), enabled: false, regexCount: 10 },
  { id: rid('big-a'), enabled: false, regexCount: 600 },
  { id: rid('big-b'), enabled: false, regexCount: 600 },
];

describe('fake dnr', () => {
  test('starts with the manifest-enabled rulesets', async () => {
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    expect(await ports.dnr.getEnabledRulesets()).toEqual(['ubo']);
  });

  test('static regex pool is over the enabled set: a set crossing 1,000 is rejected whole', async () => {
    // Arrange
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    await ports.dnr.updateEnabledRulesets({ enable: [rid('big-a')], disable: [] });

    // Act / Assert
    await expect(ports.dnr.updateEnabledRulesets({ enable: [rid('big-b')], disable: [] })).rejects.toThrow(
      /regular expression rule count limit/,
    );
    expect(await ports.dnr.getEnabledRulesets()).toEqual(['big-a', 'ubo']);
  });

  test('disabling and enabling in one call is evaluated after the disable', async () => {
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    await ports.dnr.updateEnabledRulesets({ enable: [rid('big-a')], disable: [] });
    await ports.dnr.updateEnabledRulesets({ enable: [rid('big-b')], disable: [rid('big-a')] });
    expect(await ports.dnr.getEnabledRulesets()).toEqual(['big-b', 'ubo']);
  });

  test('static rule pool (P2-26): available = pool − enabled rules; a set crossing it is rejected whole', async () => {
    // Arrange
    const rulesets = [
      { id: rid('ubo'), enabled: true, regexCount: 0, ruleCount: 20_000 },
      { id: rid('reg-a'), enabled: false, regexCount: 0, ruleCount: 6_000 },
      { id: rid('reg-b'), enabled: false, regexCount: 0, ruleCount: 6_000 },
    ];
    const { ports } = createFakeBrowser({ rulesets, limits: { staticRules: 30_000 } });

    // Act
    const before = await ports.dnr.getAvailableStaticRuleCount();
    await ports.dnr.updateEnabledRulesets({ enable: [rid('reg-a')], disable: [] });
    const after = await ports.dnr.getAvailableStaticRuleCount();

    // Assert
    expect([before, after]).toEqual([10_000, 4_000]);
    await expect(ports.dnr.updateEnabledRulesets({ enable: [rid('reg-b')], disable: [] })).rejects.toThrow(/static rule count/);
    expect(await ports.dnr.getEnabledRulesets()).toEqual(['reg-a', 'ubo']);
  });

  test('unknown ruleset ids are rejected', async () => {
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    await expect(ports.dnr.updateEnabledRulesets({ enable: [rid('nope')], disable: [] })).rejects.toThrow(/Invalid ruleset id/);
  });

  test('dynamic and session rules share one regex pool of 1,000', async () => {
    // Arrange
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    const regex = (from: number, n: number): DnrRule[] => Array.from({ length: n }, (_, i) => block(from + i, true));
    await ports.dnr.updateSessionRules({ removeRuleIds: [], addRules: regex(1, 500) });
    await ports.dnr.updateDynamicRules({ removeRuleIds: [], addRules: regex(1, 500) });

    // Act / Assert
    await expect(ports.dnr.updateSessionRules({ removeRuleIds: [], addRules: regex(501, 1) })).rejects.toThrow(/regex/);
    await expect(ports.dnr.updateDynamicRules({ removeRuleIds: [], addRules: regex(501, 1) })).rejects.toThrow(/regex/);
    expect(await ports.dnr.getDynamicRules()).toHaveLength(500);
  });

  test('updateDynamicRules rejects unknown keys at rule, condition and action level', async () => {
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    const withKey = (where: 'rule' | 'condition' | 'action'): DnrRule => {
      const rule = block(1);
      if (where === 'rule') return { ...rule, x_src: 1 } as DnrRule;
      if (where === 'condition') return { ...rule, condition: { ...rule.condition, x_src: 1 } } as DnrRule;
      return { ...rule, action: { ...rule.action, x_src: 1 } } as DnrRule;
    };
    for (const where of ['rule', 'condition', 'action'] as const) {
      await expect(ports.dnr.updateDynamicRules({ removeRuleIds: [], addRules: [withKey(where)] })).rejects.toThrow(
        /Unexpected property/,
      );
    }
    expect(await ports.dnr.getDynamicRules()).toEqual([]);
  });

  test('duplicate rule ids and out-of-range priorities are rejected; removals apply before additions', async () => {
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    await ports.dnr.updateDynamicRules({ removeRuleIds: [], addRules: [block(1)] });
    await expect(ports.dnr.updateDynamicRules({ removeRuleIds: [], addRules: [block(1)] })).rejects.toThrow(/unique ID/);
    await expect(
      ports.dnr.updateDynamicRules({ removeRuleIds: [], addRules: [{ ...block(2), priority: 2 ** 31 }] }),
    ).rejects.toThrow(/priority/);
    await ports.dnr.updateDynamicRules({ removeRuleIds: [1], addRules: [{ ...block(1), priority: 5 }] });
    expect((await ports.dnr.getDynamicRules())[0]?.priority).toBe(5);
  });

  test('unsafe dynamic rules are capped at 5,000', async () => {
    const { ports } = createFakeBrowser({ rulesets: MANIFEST, limits: { unsafeDynamicRules: 2 } });
    const redirect = (id: number): DnrRule => ({ ...block(id), action: { type: 'redirect', redirect: { extensionPath: '/x.js' } } });
    await expect(
      ports.dnr.updateDynamicRules({ removeRuleIds: [], addRules: [redirect(1), redirect(2), redirect(3)] }),
    ).rejects.toThrow(/unsafe/);
  });

  test('disabled static rule ids per ruleset', async () => {
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    await ports.dnr.updateStaticRules({ rulesetId: rid('ubo'), disableRuleIds: [3, 1, 2], enableRuleIds: [] });
    await ports.dnr.updateStaticRules({ rulesetId: rid('ubo'), disableRuleIds: [], enableRuleIds: [2] });
    expect(await ports.dnr.getDisabledRuleIds(rid('ubo'))).toEqual([1, 3]);
    await expect(ports.dnr.getDisabledRuleIds(rid('nope'))).rejects.toThrow(/Invalid ruleset id/);
  });

  test('returned rules are copies: mutating them does not change the fake', async () => {
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    await ports.dnr.updateDynamicRules({ removeRuleIds: [], addRules: [block(1)] });
    const rules = (await ports.dnr.getDynamicRules()) as DnrRule[];
    rules.pop();
    expect(await ports.dnr.getDynamicRules()).toHaveLength(1);
  });
});

describe('fake scripting', () => {
  test('one invalid match pattern fails the whole register call', async () => {
    // Arrange
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });

    // Act
    const call = ports.scripting.registerContentScripts([script('a'), script('b', ['*://*.ok.test/*', 'not a pattern'])]);

    // Assert
    await expect(call).rejects.toThrow(/Invalid url pattern/);
    expect(await ports.scripting.getRegisteredContentScripts()).toEqual([]);
  });

  test('duplicate and unknown ids are rejected, update replaces, unregister removes', async () => {
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    await ports.scripting.registerContentScripts([script('a'), script('b')]);
    await expect(ports.scripting.registerContentScripts([script('a')])).rejects.toThrow(/Duplicate script ID/);
    await expect(ports.scripting.updateContentScripts([script('zz')])).rejects.toThrow(/Nonexistent script ID/);
    await expect(ports.scripting.unregisterContentScripts(['zz'])).rejects.toThrow(/Nonexistent script ID/);
    await ports.scripting.updateContentScripts([script('a', ['*://*.c.test/*'])]);
    await ports.scripting.unregisterContentScripts(['b']);
    expect(await ports.scripting.getRegisteredContentScripts()).toEqual([script('a', ['*://*.c.test/*'])]);
  });

  test('ids starting with _ and empty matches are rejected', async () => {
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    await expect(ports.scripting.registerContentScripts([script('_a')])).rejects.toThrow(/must not start with '_'/);
    await expect(ports.scripting.registerContentScripts([script('a', [])])).rejects.toThrow(/matches/);
  });

  test('accepts the pattern shapes we emit', async () => {
    const { ports } = createFakeBrowser({ rulesets: MANIFEST });
    const patterns = ['<all_urls>', '*://*.a.test/*', '*://192.168.0.1/*', 'http://127.0.0.1/*', 'https://*/*'];
    await ports.scripting.registerContentScripts([script('a', patterns)]);
    expect(await ports.scripting.getRegisteredContentScripts()).toHaveLength(1);
  });
});

describe('simulateUpdate (S-07, S-17)', () => {
  test('clears registrations, enabled-ruleset choices and disabled ids; keeps dynamic and session rules', async () => {
    // Arrange
    const browser = createFakeBrowser({ rulesets: MANIFEST });
    const { dnr, scripting } = browser.ports;
    await scripting.registerContentScripts([script('a')]);
    await dnr.updateEnabledRulesets({ enable: [rid('ubo-x')], disable: [rid('ubo')] });
    await dnr.updateStaticRules({ rulesetId: rid('ubo'), disableRuleIds: [7], enableRuleIds: [] });
    await dnr.updateDynamicRules({ removeRuleIds: [], addRules: [block(1)] });
    await dnr.updateSessionRules({ removeRuleIds: [], addRules: [block(2)] });

    // Act
    browser.simulateUpdate();

    // Assert
    expect(await scripting.getRegisteredContentScripts()).toEqual([]);
    expect(await dnr.getEnabledRulesets()).toEqual(['ubo']);
    expect(await dnr.getDisabledRuleIds(rid('ubo'))).toEqual([]);
    expect(await dnr.getDynamicRules()).toEqual([block(1)]);
    expect(await dnr.getSessionRules()).toEqual([block(2)]);
  });
});

describe('grants, session, alarms, vault', () => {
  test('grants follow the simulated site-access setting', async () => {
    const browser = createFakeBrowser({ rulesets: MANIFEST });
    expect(await browser.ports.permissions.getGrants()).toEqual({ origins: ['<all_urls>'] });
    browser.setSiteAccess({ origins: ['http://127.0.0.1/*'] });
    expect(await browser.ports.permissions.getGrants()).toEqual({ origins: ['http://127.0.0.1/*'] });
  });

  test('session store, alarms and vault keep values by key', async () => {
    const browser = createFakeBrowser({ rulesets: MANIFEST });
    await browser.ports.session.set('k', { a: 1 });
    expect(await browser.ports.session.get('k')).toEqual({ a: 1 });
    await browser.ports.session.remove('k');
    expect(await browser.ports.session.get('k')).toBeUndefined();
    await browser.ports.alarms.setAt('pause', 5);
    expect(browser.alarms()).toEqual({ pause: 5 });
    await browser.ports.alarms.clear('pause');
    expect(browser.alarms()).toEqual({});
    await browser.ports.vault.set('settings', { x: 1 });
    expect(await browser.ports.vault.get('settings')).toEqual({ x: 1 });
  });

  test('injected faults make a named call throw once', async () => {
    const browser = createFakeBrowser({ rulesets: MANIFEST });
    browser.failNext('scripting.registerContentScripts');
    await expect(browser.ports.scripting.registerContentScripts([script('a')])).rejects.toThrow(/injected fault/);
    await browser.ports.scripting.registerContentScripts([script('a')]);
    expect(browser.calls().filter((c) => c === 'scripting.registerContentScripts')).toHaveLength(2);
  });
});
