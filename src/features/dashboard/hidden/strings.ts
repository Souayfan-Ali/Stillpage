/** Strings of the Hidden items section (P2-22, UI notes §5, §8). Text in `_locales` (P2-40). */
import { plural, t } from '../../../ui/i18n.js';

export const HIDDEN_STRINGS = {
  intro: t('hidden_intro'),
  summary: (items: number, siteCount: number) =>
    t('hidden_summary', plural(items, 'hidden_things_one', 'hidden_things_other'), plural(siteCount, 'common_sites_one', 'common_sites_other')),
  emptyHeading: t('hidden_empty_heading'),
  empty: t('hidden_empty'),
  unreadable: t('hidden_unreadable'),
  remove: t('common_remove'),
  removeLabel: (selector: string, host: string) => t('hidden_remove_label', selector, host),
  removed: t('hidden_removed'),
} as const;
