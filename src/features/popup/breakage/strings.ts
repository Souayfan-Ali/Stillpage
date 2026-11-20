/** Copy of the breakage flow (P2-14, UI notes §2, §6): outcomes, not mechanisms. Text in `_locales` (P2-40). */
import type { Complaint, Remedy } from '../../../core/breakage/types.js';
import { t } from '../../../ui/i18n.js';

export const COMPLAINTS: Readonly<Record<Complaint, string>> = {
  broken: t('breakage_complaint_broken'),
  adThrough: t('breakage_complaint_ad_through'),
  antiAdblock: t('breakage_complaint_anti_adblock'),
  popupOpened: t('breakage_complaint_popup_opened'),
};

interface RemedyCopy {
  readonly title: string;
  readonly detail: string;
  readonly action: string;
}

const TRY = t('breakage_try_action');

export const REMEDIES: Readonly<Record<Remedy, RemedyCopy>> = {
  allowPopups: { title: t('breakage_allow_popups_title'), detail: t('breakage_allow_popups_detail'), action: t('breakage_allow_popups_action') },
  light: { title: t('breakage_light_title'), detail: t('breakage_light_detail'), action: TRY },
  off: { title: t('breakage_off_title'), detail: t('breakage_off_detail'), action: TRY },
  reload: { title: t('breakage_reload_title'), detail: t('breakage_reload_detail'), action: t('breakage_reload_action') },
  picker: { title: t('breakage_picker_title'), detail: t('breakage_picker_detail'), action: t('panel_hide_something') },
  thorough: { title: t('breakage_thorough_title'), detail: t('breakage_thorough_detail'), action: TRY },
  pause: { title: t('breakage_pause_title'), detail: t('breakage_pause_detail'), action: TRY },
  strictPopups: { title: t('breakage_strict_popups_title'), detail: t('breakage_strict_popups_detail'), action: t('breakage_strict_popups_action') },
};

/** Why a rung was skipped (P2-13 `Availability`). */
export const SKIPPED: Readonly<Record<'noop' | 'capped-by-parent' | 'needs-site-access' | 'needs-guard', string>> = {
  noop: t('breakage_skipped_noop'),
  'capped-by-parent': t('breakage_skipped_capped'),
  'needs-site-access': t('breakage_skipped_needs_access'),
  'needs-guard': t('breakage_skipped_needs_guard'),
};

export const FLOW_STRINGS = {
  title: t('breakage_title'),
  back: t('common_back'),
  question: t('breakage_question'),
  start: t('common_next'),
  step: (n: number, of: number) => t('common_step_of', String(n), String(of)),
  after: (remedy: Remedy) => (remedy === 'picker' ? t('breakage_after_picker') : t('breakage_after_reload')),
  fixed: t('breakage_fixed'),
  stillBroken: t('breakage_still_broken'),
  cancel: t('breakage_cancel'),
  report: t('breakage_report'),
  reportStep: t('breakage_report_step'),
  skipped: (title: string, why: string) => t('breakage_skipped', title, why),
  done: (title: string | null) => (title === null ? t('breakage_done') : t('breakage_done_kept', title)),
  orphan: (title: string) => t('breakage_orphan', title),
  keep: t('breakage_keep'),
  undo: t('breakage_undo'),
  revertSkipped: t('breakage_revert_skipped'),
  saveFailed: t('breakage_save_failed'),
  applyFailed: t('breakage_apply_failed'),
  reloadFailed: t('breakage_reload_failed'),
  stateFailed: t('panel_unavailable'),
  pickerStarted: t('breakage_picker_started'),
  pickerMissing: t('breakage_picker_missing'),
  pickerFailed: t('breakage_picker_failed'),
  unavailable: t('breakage_unavailable'),
} as const;

export const REPORT_STRINGS = {
  label: t('report_label'),
  drafting: t('report_drafting'),
  draftFailed: t('report_draft_failed'),
  review: t('report_review'),
  noTracker: t('report_no_tracker'),
  incognito: t('report_incognito'),
  copy: t('report_copy'),
  open: t('report_open'),
  copied: t('report_copied'),
  copiedLong: t('report_copied_long'),
  copyFailed: t('common_copy_failed'),
  opened: t('report_opened'),
  openFailed: t('report_open_failed'),
} as const;
