/**
 * Credits shown in About (P2-38, UI notes §8, CREDITS.md): the authors of each upstream list (titles,
 * licences and homepages come from `packLists.ts`) and the shipped third-party code. A unit test checks
 * that every list has authors and that the shipped code matches the runtime dependencies.
 */
import type { MessageKey } from '../../../ui/i18n.js';

/** Authors by list id, as CREDITS.md records them. */
export const LIST_AUTHORS: Readonly<Record<string, string>> = {
  'ubo-quick-fixes': 'uBlock Origin team (uAssets contributors)',
  'ubo-unbreak': 'uBlock Origin team (uAssets contributors)',
  'ubo-filters': 'uBlock Origin team (uAssets contributors)',
  'ubo-privacy': 'uBlock Origin team (uAssets contributors)',
  'ubo-lite': 'uBlock Origin team (uAssets contributors)',
  'ubo-badware': 'uBlock Origin team',
  easylist: 'The EasyList authors',
  easyprivacy: 'The EasyList authors',
  urlhaus: 'curbengh (malware-filter); data: abuse.ch URLhaus',
  'easylist-cookies': 'The EasyList authors',
  'ubo-annoyances-cookies': 'uBlock Origin team',
  'easylist-newsletters': 'The EasyList authors',
  'ubo-annoyances-others': 'uBlock Origin team',
  'easylist-social': 'The EasyList authors',
  'easylist-chat': 'The EasyList authors',
  'easylist-annoyances': 'The EasyList authors',
  'easylist-notifications': 'The EasyList authors',
  'ubo-privacy-removeparam': 'uBlock Origin team, from AdGuard URL Tracking filter',
  'easylist-germany': 'The EasyList authors',
  'easylist-italy': 'The EasyList authors',
  'adguard-japanese': 'AdGuard',
  'adguard-dutch': 'AdGuard',
  'easylist-china': 'The EasyList authors',
  'easylist-spanish': 'The EasyList authors',
  'easylist-portuguese': 'The EasyList authors',
};

export interface ShippedCode {
  readonly name: string;
  /** What it does, as a message of `_locales` (P2-40). */
  readonly what: MessageKey;
  readonly licence: string;
  readonly homepage: string;
}

/** Third-party code inside the package (runtime npm packages and vendored uBO files). */
export const SHIPPED_CODE: readonly ShippedCode[] = [
  { name: 'uBlock Origin', what: 'credit_ubo_what', licence: 'GPL-3.0', homepage: 'https://github.com/gorhill/uBlock' },
  { name: 'preact', what: 'credit_preact_what', licence: 'MIT', homepage: 'https://preactjs.com/' },
  { name: '@preact/signals', what: 'credit_signals_what', licence: 'MIT', homepage: 'https://github.com/preactjs/signals' },
  { name: 'valibot', what: 'credit_valibot_what', licence: 'MIT', homepage: 'https://valibot.dev/' },
];
