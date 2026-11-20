/**
 * Strings of the Privacy section and the privacy page (P2-36, UI notes §8, security notes §10, product vision §4.1).
 * DRAFT — NOT LEGALLY REVIEWED (Q-09). The pledge is v0 (draft) until the owner signs it (Q-03).
 * Text in `_locales` (P2-40).
 */
import { PRODUCT_NAME } from '../../../core/brand.js';
import { t } from '../../../ui/i18n.js';

export const PRIVACY_STRINGS = {
  choices: t('dprivacy_choices'),
  gpc: t('common_gpc_label'),
  gpcNote: t('dprivacy_gpc_note'),
  badge: t('dprivacy_badge'),
  badgeNote: t('dprivacy_badge_note'),
  needsAccess: t('dprivacy_needs_access'),
  pageHeading: t('dprivacy_page_heading'),
  draft: t('dprivacy_draft'),
  requestsHeading: t('dprivacy_requests_heading'),
  requests: t('dprivacy_requests', PRODUCT_NAME),
  storedHeading: t('dprivacy_stored_heading'),
  stored: [t('dprivacy_stored_settings'), t('dprivacy_stored_hidden'), t('dprivacy_stored_rules')],
  notStored: t('dprivacy_not_stored'),
  permissionsHeading: t('dprivacy_permissions_heading'),
  permissionColumn: t('dprivacy_permission_column'),
  whyColumn: t('dprivacy_why_column'),
  permissionsCaption: t('dprivacy_permissions_caption'),
  notRequestedHeading: t('dprivacy_not_requested_heading'),
  pledgeHeading: t('dprivacy_pledge_heading'),
  pledge: [
    t('dprivacy_pledge_1'),
    t('dprivacy_pledge_2'),
    t('dprivacy_pledge_3'),
    t('dprivacy_pledge_4'),
    t('dprivacy_pledge_5'),
    t('dprivacy_pledge_6'),
    t('dprivacy_pledge_7'),
    t('dprivacy_pledge_8'),
  ],
  verifyHeading: t('dprivacy_verify_heading'),
  verify: t('dprivacy_verify'),
} as const;
