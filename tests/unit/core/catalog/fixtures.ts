/** A small, valid raw catalog (as JSON would deliver it). Each call returns a fresh object. */
export function rawCatalog(): Record<string, unknown> {
  return {
    schema: 1,
    rulesets: {
      ubo: { needsHostAccess: false, maxRules: 6900, maxRegex: 270 },
      'ubo-x': { needsHostAccess: true, maxRules: 500, maxRegex: 10 },
      easyprivacy: { needsHostAccess: false, maxRules: 10300, maxRegex: 15 },
      popups: { needsHostAccess: false, maxRules: 800, maxRegex: 10 },
      'reg-zh': { needsHostAccess: false, maxRules: 6500, maxRegex: 60 },
    },
    packs: {
      ads: { rulesets: ['ubo', 'ubo-x'], default: true, licence: 'cleared' },
      trackers: { rulesets: ['easyprivacy'], default: true, licence: 'cleared' },
      popups: { rulesets: ['popups'], default: true, licence: 'cleared' },
      'reg-zh': { rulesets: ['reg-zh'], default: false, licence: 'owner-pending' },
    },
  };
}
