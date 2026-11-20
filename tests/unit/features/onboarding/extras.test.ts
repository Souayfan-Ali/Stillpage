import { describe, expect, test } from 'vitest';
import { commandsFor, initialChoices, packsOf } from '../../../../src/features/onboarding/extras.js';
import { dashboard } from '../dashboard/fixtures.js';

describe('onboarding extras (P2-33)', () => {
  test('packs behind each extra; the language pack from the UI language', () => {
    const packs = packsOf(dashboard(), 'de-AT');
    expect(packs).toEqual({ cookies: ['cookies'], annoyances: ['annoy-overlays'], language: ['reg-de'], params: ['params'], gpc: ['gpc'] });
    expect(packsOf(dashboard(), 'fr-FR').language).toEqual([]);
  });

  test('first view: current state, the suggested language pre-checked; no language offered without a pack', () => {
    expect(initialChoices(dashboard(), 'de')).toEqual({ cookies: false, annoyances: false, language: true, params: false, gpc: false });
    expect(initialChoices(dashboard(), 'fr')).not.toHaveProperty('language');
  });

  test('commands only for what changes, GPC through c/setGpc', () => {
    const data = dashboard();
    expect(commandsFor(data, 'de', initialChoices(data, 'de'))).toEqual([{ extra: 'language', type: 'c/setPack', pack: 'reg-de', enabled: true }]);
    expect(commandsFor(data, 'de', { cookies: true, annoyances: true, language: false, params: true, gpc: true })).toEqual([
      { extra: 'cookies', type: 'c/setPack', pack: 'cookies', enabled: true },
      { extra: 'annoyances', type: 'c/setPack', pack: 'annoy-overlays', enabled: true },
      { extra: 'params', type: 'c/setPack', pack: 'params', enabled: true },
      { extra: 'gpc', type: 'c/setGpc', enabled: true },
    ]);
  });
});
