import { expect } from 'vitest';
import { readCatalog } from '../../../../src/core/catalog/read.js';
import type { Catalog } from '../../../../src/core/catalog/types.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import type { DefaultLevel, Level, Settings } from '../../../../src/core/state/types.js';
import type { Grants } from '../../../../src/core/reconcile/types.js';

export const NOW = 1_800_000_000_000;

export const GRANTS: Readonly<Record<'allSites' | 'specificSites' | 'onClick', Grants>> = {
  allSites: { origins: ['<all_urls>'] },
  specificSites: { origins: ['https://example.com/*', 'https://news.org/*'] },
  onClick: { origins: [] },
};

const ruleset = (unsafe: boolean, maxRegex = 10): Record<string, unknown> => ({
  needsHostAccess: unsafe,
  maxRules: 1000,
  maxRegex,
});

/** Raw catalog with two default packs carrying registrations, an opt-in pack and `popups`. */
function rawTestCatalog(): Record<string, unknown> {
  return {
    schema: 1,
    rulesets: {
      ubo: ruleset(false),
      'ubo-x': ruleset(true),
      easyprivacy: ruleset(false),
      cookies: ruleset(false),
      'cookies-x': ruleset(true),
      popups: ruleset(false),
    },
    packs: {
      ads: {
        rulesets: ['ubo', 'ubo-x'],
        default: true,
        licence: 'cleared',
        registrations: [
          { id: 'iso:ads:1', world: 'ISOLATED', js: ['cs/ads/1.js'], hosts: ['example.com', 'news.org'] },
          { id: 'main:ads:1', world: 'MAIN', js: ['sl/ads/main/1.js', 'sl/code.js'], hosts: ['example.com'] },
        ],
      },
      trackers: { rulesets: ['easyprivacy'], default: true, licence: 'cleared' },
      cookies: {
        rulesets: ['cookies', 'cookies-x'],
        default: false,
        licence: 'cleared',
        registrations: [{ id: 'iso:cookies:3', world: 'ISOLATED', js: ['cs/cookies/3.js'], hosts: ['shop.example'] }],
      },
      popups: { rulesets: ['popups'], default: true, licence: 'cleared' },
    },
  };
}

export function toCatalog(raw: unknown): Catalog {
  const result = readCatalog(raw);
  return result.ok ? result.value : expect.fail(result.errors.join('\n'));
}

export function testCatalog(): Catalog {
  return toCatalog(rawTestCatalog());
}

export interface SettingsInput {
  readonly defaultLevel?: DefaultLevel;
  readonly siteLevels?: Record<string, Level>;
  readonly pauses?: Record<string, number>;
  readonly packs?: Record<string, boolean>;
  readonly cookieBanners?: Settings['cookieBanners'];
}

export function settings(input: SettingsInput = {}): Settings {
  return {
    ...createDefaultSettings(),
    defaultLevel: input.defaultLevel ?? 'standard',
    siteLevels: (input.siteLevels ?? {}),
    pauses: Object.fromEntries(
      Object.entries(input.pauses ?? {}).map(([host, until]) => [host, { until }]),
    ),
    packs: (input.packs ?? {}),
    cookieBanners: input.cookieBanners ?? 'leave',
  };
}
