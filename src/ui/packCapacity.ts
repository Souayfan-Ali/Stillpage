/**
 * Wording of a pack that does not fit (P2-26 `no-capacity`, filter-pipeline notes §8): which limit, what the pack
 * needs and what is left, from the worker's validated `detail`. Shared by every page that toggles packs
 * (dashboard, onboarding). Plain language; numbers through `Intl`; text in `_locales` (P2-40).
 */
import type { CapacityDetail } from '../features/popup/client.js';
import { formatNumber, pluralKey, t, type MessageKey } from './i18n.js';

const LIMITS: Readonly<Record<CapacityDetail['reason'], MessageKey>> = {
  'ruleset-slots': 'capacity_limit_ruleset_slots',
  'regex-pool': 'capacity_limit_regex_pool',
  'rule-pool': 'capacity_limit_rule_pool',
  registrations: 'capacity_limit_registrations',
  patterns: 'capacity_limit_patterns',
};

/** "This pack does not fit: <limit> (it needs 1,200, 300 are left). Turn another pack off first." */
export function packCapacityText(detail: CapacityDetail | undefined): string {
  if (detail === undefined) return t('capacity_unknown_detail');
  const key = pluralKey(detail.available, 'capacity_detail_one', 'capacity_detail_other');
  return t(key, t(LIMITS[detail.reason]), formatNumber(detail.needed), formatNumber(detail.available));
}
