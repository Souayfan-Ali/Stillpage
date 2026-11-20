/** Strings of the pop-up controls (P2-60, UI notes §2: "pop-up" is a window a page opens; Q-26). Text in `_locales` (P2-40). */
import type { PopupMode } from '../../../core/state/types.js';
import { t } from '../../../ui/i18n.js';

/** Smart / Strict / Off, as the radio group and the backup preview name them. */
export const MODE_NAMES: Readonly<Record<PopupMode, string>> = { smart: t('popups_mode_smart'), strict: t('popups_mode_strict'), off: t('popups_mode_off') };

export const POPUP_STRINGS = {
  legend: t('common_popups'),
  modes: {
    smart: t('dash_popups_note_smart'),
    strict: t('dash_popups_note_strict'),
    off: t('dash_popups_note_off'),
  },
  limits: t('dash_popups_limits'),
  notActive: t('dash_popups_not_active'),
  siteNotActive: t('dash_popups_site_not_active'),
  notice: t('dash_popups_notice'),
  noticeHint: t('dash_popups_notice_hint'),
} as const;
