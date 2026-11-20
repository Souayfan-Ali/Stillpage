/**
 * User-visible strings of the dashboard shell and the Protection section (UI notes §2, §8, §10). Plain
 * language: outcomes, not mechanisms; list names only behind "Details". Text in `_locales` (P2-40).
 */
import type { CapacityDetail } from './client.js';
import { formatNumber, t, type MessageKey } from '../../ui/i18n.js';

/** Section ids, in nav order (UI notes §8; Developer arrives in P3). */
export type SectionId = 'protection' | 'sites' | 'hidden' | 'privacy' | 'backup' | 'about';
export const SECTIONS: readonly SectionId[] = ['protection', 'sites', 'hidden', 'privacy', 'backup', 'about']; // i18n-exempt: route ids

export const SECTION_TITLES: Readonly<Record<SectionId, string>> = {
  protection: t('dash_section_protection'),
  sites: t('dash_section_sites'),
  hidden: t('dash_section_hidden'),
  privacy: t('dash_section_privacy'),
  backup: t('dash_section_backup'),
  about: t('dash_section_about'),
};

/** What each pack does, as the user sees it (UI notes §2: outcomes; Q-26: "Overlays"). */
const PACK_NAMES: Readonly<Record<string, MessageKey>> = {
  ads: 'pack_name_ads',
  trackers: 'pack_name_trackers',
  malware: 'pack_name_malware',
  popups: 'pack_name_popups',
  cookies: 'pack_name_cookies',
  'annoy-overlays': 'pack_name_annoy_overlays',
  'annoy-social': 'pack_name_annoy_social',
  'annoy-widgets': 'pack_name_annoy_widgets',
  'annoy-newsletters': 'pack_name_annoy_newsletters',
  'annoy-notifications': 'pack_name_annoy_notifications',
  params: 'pack_name_params',
  gpc: 'pack_name_gpc',
  'reg-de': 'pack_name_reg_de',
  'reg-it': 'pack_name_reg_it',
  'reg-ja': 'pack_name_reg_ja',
  'reg-nl': 'pack_name_reg_nl',
  'reg-zh': 'pack_name_reg_zh',
  'reg-es-pt': 'pack_name_reg_es_pt',
};

/** One line on what each pack does (UI notes §1 item 4; D-96: the core packs too). */
export const PACK_NOTES: Readonly<Record<string, string>> = {
  ads: t('pack_note_ads'),
  trackers: t('pack_note_trackers'),
  malware: t('pack_note_malware'),
  popups: t('pack_note_popups'),
  cookies: t('pack_note_cookies'),
  'annoy-overlays': t('pack_note_annoy_overlays'),
  'annoy-social': t('pack_note_annoy_social'),
  'annoy-widgets': t('pack_note_annoy_widgets'),
  'annoy-newsletters': t('pack_note_annoy_newsletters'),
  'annoy-notifications': t('pack_note_annoy_notifications'),
  params: t('pack_note_params'),
  gpc: t('pack_note_gpc'),
};

/** The pack's name; an id the catalog does not know is shown as it is. */
export const packName = (id: string): string => {
  const key = PACK_NAMES[id];
  return key === undefined ? id : t(key);
};

export const isRegional = (id: string): boolean => id.startsWith('reg-');

/** The always-useful packs, shown first as "Core protection" (D-96); the other non-regional packs are "Extras". */
export const CORE_PACKS: ReadonlySet<string> = new Set(['ads', 'trackers', 'malware', 'popups']); // i18n-exempt: pack ids

/** The inline error for a refused pack (design review, P2-26): numbers only for the rule pool. */
export function packRefusalText(detail: CapacityDetail | undefined): string {
  if (detail?.reason === 'rule-pool') return t('dash_refusal_rule_pool', formatNumber(detail.needed), formatNumber(detail.available));
  return t('dash_refusal_other');
}

export const STRINGS = {
  loading: t('common_loading'),
  unavailable: t('dash_unavailable'),
  readFailed: t('dash_read_failed'),
  saving: t('common_saving'),
  saved: t('common_saved'),
  saveFailed: t('common_save_failed'),
  noAnswer: t('dash_no_answer'),
  notAvailable: t('common_not_available'),
  accessGranted: t('common_access_granted'),
  accessDenied: t('common_access_denied'),
  navLabel: t('dash_nav_label'),
  finishSetup: t('dash_finish_setup'),
  setupAgain: t('dash_setup_again'),
  lastRunFailed: t('dash_last_run_failed'),
  reset: t('dash_reset'),
  restore: t('common_restore_backup'),
  noAccess: t('dash_no_access'),
  allowAll: t('common_allow_all'),
  defaultLevel: t('dash_default_level'),
  defaultLevelNote: t('dash_default_level_note'),
  core: t('dash_core'),
  extras: t('dash_extras'),
  alwaysOn: t('dash_always_on'),
  languages: t('dash_languages'),
  ownerPending: t('dash_owner_pending'),
  /** The disclosure's visible word (D-96); `details(name)` is its accessible name, which starts with it. */
  detailsSummary: t('common_details'),
  details: (name: string) => t('dash_details', name),
  upTo: (n: number) => t('dash_up_to', formatNumber(n)),
  listsHeading: t('dash_lists_heading'),
  homepage: t('dash_homepage'),
  licence: t('common_licence'),
  skipped: t('dash_skipped'),
  offer: t('dash_offer'),
  useThorough: t('dash_use_thorough'),
  notNow: t('dash_not_now'),
  capacity: t('dash_capacity'),
  capacityUsed: (used: number, guaranteed: number) => t('dash_capacity_used', formatNumber(used), formatNumber(guaranteed)),
  capacityOver: (extra: number) => t('dash_capacity_over', formatNumber(extra)),
  capacityLeft: (n: number) => t('dash_capacity_left', formatNumber(n)),
  capacityUnknown: t('dash_capacity_unknown'),
} as const;
