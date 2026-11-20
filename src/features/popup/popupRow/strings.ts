/** Copy of the toolbar panel's pop-up row (P2-60b, UI notes §3, §6a). "Pop-up" is a window a page opens (UI notes §2). */
import type { PopupMode } from '../../../core/state/types.js';
import { plural, t } from '../../../ui/i18n.js';

const MODE_NAMES: Readonly<Record<PopupMode, string>> = { smart: t('popups_mode_smart'), strict: t('popups_mode_strict'), off: t('popups_mode_off') };

export const ROW_STRINGS = {
  label: t('row_label'),
  default: (mode: PopupMode) => t('row_default', MODE_NAMES[mode]),
  allow: t('popups_allowed'),
  strict: MODE_NAMES.strict,
  notActive: t('row_not_active'),
  blocked: (n: number) => plural(n, 'row_blocked_one', 'row_blocked_other'),
  none: t('row_none'),
  noSentinel: t('row_no_sentinel'),
  listLabel: t('row_list_label'),
  open: (host: string) => t('row_open', host),
  saved: t('row_saved'),
  failed: t('common_save_failed'),
  opened: t('row_opened'),
} as const;
