import { describe, expect, test } from 'vitest';
import { applyHostAccessGate, hasAllSitesAccess } from '../../../../src/core/reconcile/hostAccess.js';
import { hostPattern } from '../../../../src/core/reconcile/registrations.js';
import type { DnrRule } from '../../../../src/core/reconcile/types.js';
import { parseHostname } from '../../../../src/core/hostname/validate.js';
import { GRANTS } from './fixtures.js';

const rule = (id: number, type: DnrRule['action']['type']): DnrRule => ({
  id,
  priority: 2,
  action: { type },
  condition: { requestDomains: ['ads.example'], resourceTypes: ['main_frame'] },
});

describe('host-access gate', () => {
  test.each([
    ['all sites', GRANTS.allSites, true],
    ['specific sites', GRANTS.specificSites, false],
    ['on click', GRANTS.onClick, false],
    ['a wildcard origin that is not <all_urls>', { origins: ['*://*/*'] }, false],
  ] as const)('%s → %s', (_name, grants, expected) => {
    expect(hasAllSitesAccess(grants)).toBe(expected);
  });

  test('keeps redirect and modifyHeaders rules only with all-sites access', () => {
    const rules = [rule(1, 'block'), rule(2, 'redirect'), rule(3, 'modifyHeaders'), rule(4, 'allow')];

    expect(applyHostAccessGate(rules, true).map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(applyHostAccessGate(rules, false).map((r) => r.id)).toEqual([1, 4]);
    expect(applyHostAccessGate(rules, true)).not.toBe(rules);
  });
});

describe('hostPattern', () => {
  test('uses a subdomain wildcard for names and the exact host for IPv4', () => {
    expect(hostPattern(parseHostname('example.com') ?? expect.fail())).toBe('*://*.example.com/*');
    expect(hostPattern(parseHostname('192.168.0.1') ?? expect.fail())).toBe('*://192.168.0.1/*');
  });
});
