/**
 * Upstream lists of each pack, for the Protection section's "Details" and the Credits (P2-34, P2-38).
 * A projection of `lists/lists.config.json` (id, title, licence, homepage; pack → lists; `popups` takes the
 * lists of the rulesets it is built from), written here so
 * the page bundles only these fields; `tests/unit/features/dashboard/packLists.test.ts` checks that it
 * equals the config. Regenerate it when a full release changes the lists.
 */

export interface UpstreamList {
  readonly title: string;
  readonly licence: string;
  readonly homepage: string;
}

export const LISTS: Readonly<Record<string, UpstreamList>> = {
  'ubo-quick-fixes': { title: 'uBlock filters – Quick fixes', licence: 'GPL-3.0-only', homepage: 'https://github.com/uBlockOrigin/uAssets' },
  'ubo-unbreak': { title: 'uBlock filters – Unbreak', licence: 'GPL-3.0-only', homepage: 'https://github.com/uBlockOrigin/uAssets' },
  'ubo-filters': { title: 'uBlock filters – Ads', licence: 'GPL-3.0-only', homepage: 'https://github.com/uBlockOrigin/uAssets' },
  'ubo-privacy': { title: 'uBlock filters – Privacy', licence: 'GPL-3.0-only', homepage: 'https://github.com/uBlockOrigin/uAssets' },
  'ubo-lite': { title: 'uBO Lite filters', licence: 'GPL-3.0-only', homepage: 'https://github.com/uBlockOrigin/uAssets' },
  'ubo-badware': { title: 'uBlock filters – Badware risks', licence: 'GPL-3.0-only', homepage: 'https://github.com/uBlockOrigin/uAssets' },
  easylist: { title: 'EasyList', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
  easyprivacy: { title: 'EasyPrivacy', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
  urlhaus: { title: 'Malicious Hosts Blocklist (URLhaus, hosts variant)', licence: 'CC0-1.0', homepage: 'https://gitlab.com/malware-filter/urlhaus-filter' },
  'easylist-cookies': { title: 'EasyList – Cookie Notices', licence: 'CC-BY-3.0', homepage: 'https://easylist.to/' },
  'ubo-annoyances-cookies': { title: 'uBlock filters – Cookie Notices', licence: 'GPL-3.0-only', homepage: 'https://github.com/uBlockOrigin/uAssets' },
  'easylist-newsletters': { title: 'EasyList – Newsletter Notices', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
  'ubo-annoyances-others': { title: 'uBlock filters – Other Annoyances', licence: 'GPL-3.0-only', homepage: 'https://github.com/uBlockOrigin/uAssets' },
  'easylist-social': { title: 'EasyList – Social Widgets', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
  'easylist-chat': { title: 'EasyList – Chat Widgets', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
  'easylist-annoyances': { title: 'EasyList – Annoyances', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
  'easylist-notifications': { title: 'EasyList – Notifications', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
  'ubo-privacy-removeparam': { title: 'uBlock filters – URL Tracking Protection', licence: 'GPL-3.0-only', homepage: 'https://github.com/uBlockOrigin/uAssets' },
  'easylist-germany': { title: 'EasyList Germany', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
  'easylist-italy': { title: 'EasyList Italy', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
  'adguard-japanese': { title: 'AdGuard Japanese filter', licence: 'GPL-3.0-only', homepage: 'https://github.com/AdguardTeam/AdguardFilters' },
  'adguard-dutch': { title: 'AdGuard Dutch filter', licence: 'GPL-3.0-only', homepage: 'https://github.com/AdguardTeam/AdguardFilters' },
  'easylist-china': { title: 'EasyList China', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
  'easylist-spanish': { title: 'EasyList Spanish', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
  'easylist-portuguese': { title: 'EasyList Portuguese', licence: 'GPL-3.0-or-later OR CC-BY-SA-3.0', homepage: 'https://easylist.to/' },
};

export const PACK_LISTS: Readonly<Record<string, readonly string[]>> = {
  ads: ['ubo-quick-fixes', 'ubo-unbreak', 'ubo-filters', 'ubo-privacy', 'ubo-lite', 'easylist'],
  trackers: ['easyprivacy'],
  malware: ['ubo-badware', 'urlhaus'],
  popups: ['ubo-quick-fixes', 'ubo-unbreak', 'ubo-filters', 'ubo-privacy', 'ubo-lite', 'easylist', 'easyprivacy', 'ubo-badware'],
  cookies: ['easylist-cookies', 'ubo-annoyances-cookies'],
  'annoy-overlays': ['easylist-newsletters', 'ubo-annoyances-others'],
  'annoy-social': ['easylist-social'],
  'annoy-widgets': ['easylist-chat'],
  'annoy-newsletters': ['easylist-annoyances'],
  'annoy-notifications': ['easylist-notifications'],
  params: ['ubo-privacy-removeparam'],
  gpc: [],
  'reg-de': ['easylist-germany'],
  'reg-it': ['easylist-italy'],
  'reg-ja': ['adguard-japanese'],
  'reg-nl': ['adguard-dutch'],
  'reg-zh': ['easylist-china'],
  'reg-es-pt': ['easylist-spanish', 'easylist-portuguese'],
};
