/** Strings of the Backup section (P2-37): what a restore will change, in plain words. Text in `_locales` (P2-40). */
import type { BackupProblem } from '../../../core/state/backup.js';
import { formatNumber, plural, t } from '../../../ui/i18n.js';
import type { BackupPreview } from './backupStore.js';
import { LEVEL_LABELS } from '../sites/strings.js';
import { packName } from '../strings.js';
import { MODE_NAMES } from '../sections/popupStrings.js';

type Change = BackupPreview['changes'][number];
type Dropped = BackupPreview['dropped'][number];

const onOff = (on: boolean): string => (on ? t('backup_on') : t('backup_off'));
const THEME = { system: t('backup_theme_system'), light: t('backup_theme_light'), dark: t('backup_theme_dark') } as const;
/** Joins the parts of one change line; punctuation only, so it needs no message. */
const LIST_SEPARATOR = ', ';

function sites(n: { added: number; removed: number; changed: number }): string {
  const parts = [
    n.added > 0 ? t('backup_added', formatNumber(n.added)) : '',
    n.removed > 0 ? t('backup_removed', formatNumber(n.removed)) : '',
    n.changed > 0 ? t('backup_changed', formatNumber(n.changed)) : '',
  ];
  return parts.filter((p) => p !== '').join(LIST_SEPARATOR);
}

/** One line of the preview per change. */
export function changeText(change: Change): string {
  switch (change.kind) {
    case 'defaultLevel':
      return t('backup_change_default_level', LEVEL_LABELS[change.from], LEVEL_LABELS[change.to]);
    case 'pack':
      return t('backup_change_pack', packName(change.pack), onOff(change.to));
    case 'siteLevels':
      return t('backup_change_site_levels', sites(change));
    case 'popupMode':
      return t('backup_change_popup_mode', MODE_NAMES[change.from], MODE_NAMES[change.to]);
    case 'popupSites':
      return t('backup_change_popup_sites', sites(change));
    case 'popupNotice':
      return t('backup_change_popup_notice', onOff(change.to));
    case 'gpc':
      return t('backup_change_gpc', onOff(change.to));
    case 'badge':
      return t('backup_change_badge', onOff(change.to));
    case 'theme':
      return t('backup_change_theme', THEME[change.to]);
    case 'hidden':
      return t('backup_change_hidden', sites({ added: change.added, removed: change.removed, changed: 0 }));
  }
}

/** How many hosts a warning or a dropped line names before "and N more" (design review, P2-43). */
const NAMED_HOSTS = 10;

/** `a, b, c` or `a, …, j and N more`. */
function hostList(hosts: readonly string[]): string {
  const named = hosts.slice(0, NAMED_HOSTS).join(LIST_SEPARATOR);
  return hosts.length > NAMED_HOSTS ? t('backup_hosts_more', named, formatNumber(hosts.length - NAMED_HOSTS)) : named;
}

export function droppedText(dropped: Dropped): string {
  if (dropped.reason === 'suffix') return t('backup_dropped_suffix', hostList(dropped.hosts));
  const name = packName(dropped.pack);
  if (dropped.reason === 'unavailable') return t('backup_dropped_unavailable', name);
  if (dropped.reason === 'not-toggleable') return t('backup_dropped_fixed', name);
  return t('backup_dropped_room', name);
}

const sitesWord = (n: number): string => plural(n, 'common_sites_one', 'common_sites_other');

/** Changes that lower protection, said on their own (security review M1). */
export function warningsOf(preview: BackupPreview): readonly string[] {
  return preview.changes.flatMap((change): string[] => {
    if (change.kind === 'siteLevels' && change.weakened > 0) return [t('backup_warn_off', sitesWord(change.weakened), hostList(change.weakenedHosts))];
    if (change.kind === 'popupSites' && change.weakened > 0) return [t('backup_warn_popups', sitesWord(change.weakened), hostList(change.weakenedHosts))];
    return [];
  });
}

export const PROBLEM_TEXT: Readonly<Record<BackupProblem | 'unreadable', string>> = {
  'too-large': t('backup_problem_too_large'),
  'not-json': t('backup_problem_not_json'),
  'not-backup': t('backup_problem_not_backup'),
  newer: t('backup_problem_newer'),
  invalid: t('backup_problem_invalid'),
  unreadable: t('backup_problem_unreadable'),
};

export const BACKUP_STRINGS = {
  exportHeading: t('backup_export_heading'),
  exportNote: t('backup_export_note'),
  exportButton: t('backup_export_button'),
  exported: t('backup_exported'),
  importHeading: t('common_restore_backup'),
  resetNote: t('backup_reset_note'),
  file: t('backup_file'),
  fileNote: t('backup_file_note'),
  reading: t('backup_reading'),
  previewHeading: t('backup_preview_heading'),
  noChanges: t('backup_no_changes'),
  restore: t('backup_restore'),
  cancel: t('common_cancel'),
  restored: t('backup_restored'),
  restoreFailed: t('backup_restore_failed'),
  unknown: t('backup_unknown'),
  stale: t('backup_stale'),
  filtersKept: t('backup_filters_kept'),
  restoredNotApplied: t('backup_restored_not_applied'),
  warningsHeading: t('backup_warnings_heading'),
} as const;
