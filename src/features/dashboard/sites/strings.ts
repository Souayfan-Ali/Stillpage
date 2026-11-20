/** Strings of the Sites section (P2-35, UI notes §2: "Off on this site", levels by name). Text in `_locales` (P2-40). */
import { MAX_SITES_PER_LEVEL } from '../../../core/limits.js';
import type { Level } from '../../../core/state/types.js';
import { formatNumber, formatTime, plural, t } from '../../../ui/i18n.js';

export const LEVEL_LABELS: Readonly<Record<Level, string>> = { off: t('level_off'), light: t('level_light'), standard: t('level_standard'), thorough: t('level_thorough') };

export const SITE_STRINGS = {
  addHeading: t('sites_add_heading'),
  hostname: t('sites_hostname'),
  hostnameHint: t('sites_hostname_hint'),
  levelFor: t('sites_level'),
  add: t('sites_add'),
  invalid: t('sites_invalid'),
  full: t('sites_full', formatNumber(MAX_SITES_PER_LEVEL)),
  listHeading: t('sites_list_heading'),
  search: t('sites_search'),
  empty: t('sites_empty'),
  noMatch: t('sites_no_match'),
  caption: t('sites_caption'),
  selectColumn: t('sites_select_column'),
  site: t('sites_site'),
  level: t('sites_level'),
  popups: t('common_popups'),
  actions: t('sites_actions'),
  inherit: t('sites_inherit'),
  levelOf: (host: string) => t('sites_level_of', host),
  select: (host: string) => t('sites_select', host),
  remove: t('common_remove'),
  removeLabel: (host: string) => t('sites_remove_label', host),
  removeSelected: (n: number) => plural(n, 'sites_remove_selected_one', 'sites_remove_selected_other'),
  pausedUntil: (until: number) => t('sites_paused_until', formatTime(until)),
  resume: t('sites_resume'),
  resumeLabel: (host: string) => t('sites_resume_label', host),
  popupAllow: t('popups_allowed'),
  popupStrict: t('popups_mode_strict'),
  popupsOf: (host: string) => t('sites_popups_of', host),
  popupsNote: t('sites_popups_note'),
} as const;
