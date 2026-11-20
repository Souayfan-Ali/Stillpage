import { describe, expect, test } from 'vitest';
import { matchExtension, outcomeOf } from '../../../../compiler/release/match.js';
import { readZip } from '../../../../compiler/release/zip.js';
import { block, extensionZip, rulesText } from './fixtures.js';

describe('match check for incident drills (P2-51)', () => {
  const zip = extensionZip();
  const rules = new Map([['ubo', [block(1, 'a.example'), { id: 2, priority: 20, action: { type: 'allow' }, condition: { requestDomains: ['a.example'] } }]]]);

  test('the outcome is the action of the matched rule with the highest priority; nothing matched = allowed', () => {
    expect(outcomeOf([], rules)).toBe('allowed');
    expect(outcomeOf([{ rulesetId: 'ubo', ruleId: 1 }], rules)).toBe('blocked');
    expect(outcomeOf([{ rulesetId: 'ubo', ruleId: 1 }, { rulesetId: 'ubo', ruleId: 2 }], rules)).toBe('allowed');
    const tie = new Map([['ubo', [block(1, 'a.example'), { id: 3, priority: 10, action: { type: 'allow' }, condition: {} }]]]);
    expect(outcomeOf([{ rulesetId: 'ubo', ruleId: 1 }, { rulesetId: 'ubo', ruleId: 3 }], tie)).toBe('allowed');
    expect(() => outcomeOf([{ rulesetId: 'ubo', ruleId: 9 }], rules)).toThrow(/unknown rule/);
  });

  test('the drill extension carries the zip\'s rulesets with their default state, plus feedback permission', () => {
    const ext = matchExtension(readZip(zip));
    const manifest = JSON.parse(new TextDecoder().decode(ext.get('manifest.json'))) as { permissions: string[]; declarative_net_request: { rule_resources: { id: string; enabled: boolean }[] } };
    expect(manifest.permissions).toEqual(['declarativeNetRequest', 'declarativeNetRequestFeedback']);
    expect(manifest.declarative_net_request.rule_resources.map((r) => [r.id, r.enabled])).toEqual([['ubo', true], ['ubo-x', false], ['easylist', true]]);
    expect(new TextDecoder().decode(ext.get('rulesets/easylist.json'))).toBe(rulesText([block(1, 'banner.example')]));
    expect([...ext.keys()].sort()).toEqual(['bg.js', 'manifest.json', 'rulesets/easylist.json', 'rulesets/ubo-x.json', 'rulesets/ubo.json']);
  });
});

describe('drill: a bad but eligible rule (P2-51)', () => {
  test('adds one safe main_frame block for the host to ubo with a fresh ledger id, other rulesets unchanged', async () => {
    const { withBadRule } = await import('../../../../compiler/release/match.js');
    const ledger = { schema: 1 as const, ruleset: 'ubo', nextId: 21, entries: { 'r:00000000000000000001': 1 } };
    const out = withBadRule(readZip(extensionZip()), ledger, 'en.wikipedia.org');
    expect(out.ledger.nextId).toBe(22);
    expect(out.ledger.entries).toMatchObject({ 'r:incident-drill-en.wikipedia.org': 21 });
    const ubo = JSON.parse(new TextDecoder().decode(out.rulesets.get('rulesets/ubo.json'))) as { id: number; action: { type: string }; condition: { requestDomains?: string[]; resourceTypes?: string[] } }[];
    expect(ubo.at(-1)).toEqual({ id: 21, priority: 10, action: { type: 'block' }, condition: { requestDomains: ['en.wikipedia.org'], resourceTypes: ['main_frame'] } });
    expect(new TextDecoder().decode(out.rulesets.get('rulesets/easylist.json'))).toBe(rulesText([block(1, 'banner.example')]));
    expect(out.rulesets.has('rulesets/ubo-x.json')).toBe(false);
    expect(() => withBadRule(readZip(extensionZip()), ledger, 'not a host/')).toThrow(/host/);
  });
});
