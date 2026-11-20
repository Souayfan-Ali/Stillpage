/** Strings of About and Credits (P2-38). The licence wording follows CREDITS.md (ADR-002). Text in `_locales` (P2-40). */
import { formatNumber, t } from '../../../ui/i18n.js';

export const ABOUT_STRINGS = {
  version: t('about_version'),
  rulesDate: t('about_rules_date'),
  licence: t('common_licence'),
  licenceText: t('about_licence_text'),
  source: t('about_source'),
  credits: t('about_credits'),
  creditsIntro: t('about_credits_intro'),
  listsHeading: (count: number) => t('about_lists_heading', formatNumber(count)),
  codeHeading: t('about_code_heading'),
  unknownAuthors: t('about_unknown_authors'),
} as const;
