/**
 * The privacy page's permissions table (P2-36, design review 2026-11-14): the one source of the user-facing
 * rows. `tests/unit/features/dashboard/permissions.test.ts` checks that these rows name exactly the
 * permissions the manifest declares and the `declared` rows of `docs/permissions.md`, so a new
 * permission cannot ship without a line here. Text in `_locales` (P2-40).
 */
import { t } from '../../../ui/i18n.js';

export interface PermissionRow {
  readonly permission: string;
  /** What Chrome calls it in its own prompts, or the API name when Chrome shows no prompt. */
  readonly name: string;
  readonly why: string;
}

export const PERMISSION_ROWS: readonly PermissionRow[] = [
  { permission: 'declarativeNetRequest', name: t('perm_dnr_name'), why: t('perm_dnr_why') },
  { permission: '<all_urls>', name: t('perm_all_urls_name'), why: t('perm_all_urls_why') },
  { permission: 'scripting', name: t('perm_scripting_name'), why: t('perm_scripting_why') },
  { permission: 'storage', name: t('perm_storage_name'), why: t('perm_storage_why') },
  { permission: 'unlimitedStorage', name: t('perm_unlimited_storage_name'), why: t('perm_unlimited_storage_why') },
  { permission: 'activeTab', name: t('perm_active_tab_name'), why: t('perm_active_tab_why') },
  { permission: 'contextMenus', name: t('perm_context_menus_name'), why: t('perm_context_menus_why') },
  { permission: 'alarms', name: t('perm_alarms_name'), why: t('perm_alarms_why') },
];

/** Never asked for (ADR-007 item 3), with the reason in plain words. */
export const NOT_REQUESTED: readonly PermissionRow[] = [
  { permission: 'tabs', name: t('perm_tabs_name'), why: t('perm_tabs_why') },
  { permission: 'webNavigation', name: t('perm_web_navigation_name'), why: t('perm_web_navigation_why') },
  { permission: 'webRequest', name: t('perm_web_request_name'), why: t('perm_web_request_why') },
  { permission: 'declarativeNetRequestFeedback', name: t('perm_dnr_feedback_name'), why: t('perm_dnr_feedback_why') },
];
