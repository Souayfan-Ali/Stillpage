/**
 * Privacy panel copy (P2-12, UI notes §4). Plain language: categories and companies, never request
 * URLs; "blocked requests matched N rules" where precision matters. Text in `_locales` (P2-40).
 */
import type { Category } from '../../../core/buckets/buckets.js';
import { formatNumber, plural, t } from '../../../ui/i18n.js';

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  ads: t('privacy_cat_ads'),
  tracking: t('privacy_cat_tracking'),
  malware: t('privacy_cat_malware'),
  popup: t('privacy_cat_popup'),
  cookies: t('privacy_cat_cookies'),
  annoyance: t('privacy_cat_annoyance'),
  params: t('privacy_cat_params'),
  regional: t('privacy_cat_regional'),
  other: t('privacy_cat_other'),
};

/** The "Other" row inside each category. */
export const OTHER_LABELS: Readonly<Record<Category, string>> = {
  ads: t('privacy_other_ads'),
  tracking: t('privacy_other_tracking'),
  malware: t('privacy_other_malware'),
  popup: t('privacy_other_popup'),
  cookies: t('privacy_other_cookies'),
  annoyance: t('privacy_other_annoyance'),
  params: t('privacy_other_params'),
  regional: t('privacy_cat_other'),
  other: t('privacy_cat_other'),
};

/** Short nouns for the card's second line ("14 ads · 13 trackers"). */
export const CATEGORY_NOUNS: Readonly<Record<Category, (n: number) => string>> = {
  ads: (n) => plural(n, 'privacy_noun_ads_one', 'privacy_noun_ads_other'),
  tracking: (n) => plural(n, 'privacy_noun_tracking_one', 'privacy_noun_tracking_other'),
  malware: (n) => plural(n, 'privacy_noun_malware_one', 'privacy_noun_malware_other'),
  popup: (n) => plural(n, 'privacy_noun_popup_one', 'privacy_noun_popup_other'),
  cookies: (n) => plural(n, 'privacy_noun_cookies_one', 'privacy_noun_cookies_other'),
  annoyance: (n) => plural(n, 'privacy_noun_annoyance_one', 'privacy_noun_annoyance_other'),
  params: (n) => plural(n, 'privacy_noun_params_one', 'privacy_noun_params_other'),
  regional: (n) => t('privacy_noun_regional', formatNumber(n)),
  other: (n) => t('privacy_noun_other', formatNumber(n)),
};

export const PRIVACY_STRINGS = {
  blocked: (n: number) => t('privacy_blocked', formatNumber(n)),
  companies: (n: number) => plural(n, 'privacy_companies_one', 'privacy_companies_other'),
  nothing: t('privacy_nothing'),
  loading: t('privacy_loading'),
  unavailableCard: t('privacy_title_no_host'),
  open: t('privacy_open'),
  title: (host: string) => t('privacy_title', host),
  titleNoHost: t('privacy_title_no_host'),
  back: t('common_back'),
  unavailable: t('privacy_unavailable'),
  stale: t('privacy_stale'),
  failed: t('privacy_failed'),
  empty: t('privacy_empty'),
  scope: t('privacy_scope'),
  local: t('privacy_local'),
  howTitle: t('privacy_how_title'),
  how: [t('privacy_how_matcher'), t('privacy_how_left'), t('privacy_how_hidden')],
  precise: (requests: number, rules: number) =>
    t('privacy_precise', plural(requests, 'privacy_requests_one', 'privacy_requests_other'), plural(rules, 'privacy_rules_one', 'privacy_rules_other')),
  popupsBlocked: (n: number) => t('privacy_popups_blocked', formatNumber(n)),
  copy: t('privacy_copy'),
  copied: t('privacy_copied'),
  copyFailed: t('common_copy_failed'),
} as const;
