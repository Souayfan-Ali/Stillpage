import { describe, expect, test } from 'vitest';
import type { Hostname } from '../../../../src/core/ids.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import { withoutSites } from '../../../../src/core/state/sites.js';
import type { Settings } from '../../../../src/core/state/types.js';

describe('withoutSites (P2-35)', () => {
  test('drops every stored choice of the hosts and nothing else; input untouched', () => {
    const before: Settings = {
      ...createDefaultSettings(),
      siteLevels: { 'a.test': 'off', 'b.test': 'light' } as Settings['siteLevels'],
      pauses: { 'a.test': { until: 5 }, 'c.test': { until: 6 } } as Settings['pauses'],
      popups: { mode: 'smart', sites: { 'a.test': 'allow', 'b.test': 'strict' } as Settings['popups']['sites'], notice: false },
    };
    const after = withoutSites(before, ['a.test', 'zz.test'] as Hostname[]);
    expect(after.siteLevels).toEqual({ 'b.test': 'light' });
    expect(after.pauses).toEqual({ 'c.test': { until: 6 } });
    expect(after.popups).toEqual({ mode: 'smart', sites: { 'b.test': 'strict' }, notice: false });
    expect(before.siteLevels).toEqual({ 'a.test': 'off', 'b.test': 'light' });
  });
});
