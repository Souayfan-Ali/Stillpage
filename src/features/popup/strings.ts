/**
 * Every user-visible string of the toolbar panel (UI notes §2, §3, §10). Plain language: outcomes, not
 * mechanisms; no "ruleset", "DNR" or "popup" (our panel is never called a popup in the copy). The text
 * lives in `_locales` (P2-40); this module maps the panel's names to messages.
 */
import type { Level } from '../../core/state/types.js';
import { plural, t } from '../../ui/i18n.js';

type ChoosableLevel = Exclude<Level, 'off'>;

export const LEVEL_NAMES: Readonly<Record<Level, string>> = {
  off: t('level_off'),
  light: t('level_light'),
  standard: t('level_standard'),
  thorough: t('level_thorough'),
};

/** One-line outcome and cost of each level (UI notes §2). */
export const LEVEL_DESCRIPTIONS: Readonly<Record<ChoosableLevel, string>> = {
  light: t('level_light_note'),
  standard: t('level_standard_note'),
  thorough: t('level_thorough_note'),
};

export const STRINGS = {
  loading: t('common_loading'),
  levelLegend: t('panel_level_legend'),
  noHost: t('panel_no_host'),
  protected: (level: Level) => t('panel_protected', LEVEL_NAMES[level]),
  off: t('panel_off'),
  paused: (minutes: number) => plural(minutes, 'panel_paused_one', 'panel_paused_other'),
  reduced: t('panel_reduced'),
  limited: (level: Level) => t('panel_limited', LEVEL_NAMES[level]),
  restricted: t('panel_restricted'),
  admin: t('panel_admin'),
  setup: t('panel_setup'),
  reset: t('panel_reset'),
  capped: (host: string) => t('panel_capped', host),
  unavailable: t('panel_unavailable'),
  noHostLevels: t('panel_no_host_levels'),
  saving: t('common_saving'),
  saved: t('panel_saved'),
  saveFailed: t('common_save_failed'),
  accessGranted: t('common_access_granted'),
  accessDenied: t('common_access_denied'),
  notAvailableYet: t('common_not_available'),
  done: t('panel_done'),
  somethingWrong: t('panel_something_wrong'),
  chunkFailed: t('panel_chunk_failed'),
  reloadPage: t('panel_reload_page'),
  reloaded: t('panel_reloaded'),
  reloadFailed: t('panel_reload_failed'),
  retrying: t('panel_retrying'),
  rulesFrom: (date: string) => t('panel_rules_from', date),
  version: (version: string) => t('panel_version', version),
  /** Footer link to the dashboard's "Hidden items" (P2-22, D-91: the section's own name). */
  hiddenItems: t('dash_section_hidden'),
  pause: {
    open: t('panel_pause_open'),
    label: t('panel_pause_label'),
    thirty: t('panel_pause_thirty'),
    hour: t('panel_pause_hour'),
    untilOn: t('panel_pause_until_on'),
  },
  pickerUnavailable: t('panel_picker_unavailable'),
  hideSomething: t('panel_hide_something'),
  actions: {
    turnOn: t('panel_turn_on'),
    resume: t('panel_resume'),
    allowSite: t('panel_allow_site'),
    allowAll: t('common_allow_all'),
    restore: t('common_restore_backup'),
    dismiss: t('common_dismiss'),
  },
} as const;
