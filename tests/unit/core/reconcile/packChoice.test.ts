import { describe, expect, test } from 'vitest';
import type { PackId } from '../../../../src/core/ids.js';
import { chosenPacks, packRefusal, withPack } from '../../../../src/core/reconcile/packChoice.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import { testCatalog } from './fixtures.js';

describe('packChoice', () => {
  test('chosenPacks: catalog defaults, overridden by explicit choices, in catalog order', () => {
    const catalog = testCatalog();
    expect(chosenPacks(createDefaultSettings(), catalog)).toEqual(['ads', 'trackers', 'popups']);
    const settings = withPack(withPack(createDefaultSettings(), 'cookies' as PackId, true), 'trackers' as PackId, false);
    expect(chosenPacks(settings, catalog)).toEqual(['ads', 'cookies', 'popups']);
  });

  test('packRefusal: unknown and not-toggleable packs', () => {
    expect(packRefusal(testCatalog(), 'nope' as PackId)).toBe('not-found');
    expect(packRefusal(testCatalog(), 'popups' as PackId)).toBe('not-toggleable');
    expect(packRefusal(testCatalog(), 'cookies' as PackId)).toBeNull();
  });
});
