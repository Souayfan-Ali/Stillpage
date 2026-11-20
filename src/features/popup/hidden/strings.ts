/** Copy of the panel's "Show on page" view (P2-22b, UI notes §5; Remove: P3-17). Text in `_locales` (P2-40). */
import { formatNumber, pluralKey, t } from '../../../ui/i18n.js';

const MS_PER_SECOND = 1_000;
const seconds = (ms: number): string => formatNumber(Math.round(ms / MS_PER_SECOND));

export const SHOW_STRINGS = {
  open: (n: number) => t('panel_hidden_open', formatNumber(n)),
  title: (host: string) => t('show_title', host),
  intro: (ms: number) => t('show_intro', seconds(ms)),
  show: t('show_button'),
  showLabel: (selector: string) => t('show_button_label', selector),
  shown: (n: number, ms: number) => t(pluralKey(n, 'show_shown_one', 'show_shown_other'), formatNumber(n), seconds(ms)),
  noMatch: t('show_no_match'),
  failed: t('show_failed'),
  reverted: t('show_reverted'),
  empty: t('show_empty'),
  remove: t('common_remove'),
  removeLabel: (selector: string, host: string) => t('hidden_remove_label', selector, host),
  removed: t('hidden_removed'),
  removeFailed: t('show_remove_failed'),
  back: t('common_back'),
} as const;
