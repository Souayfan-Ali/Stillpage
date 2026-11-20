/**
 * The dashboard's view of the settings (P2-34, design review 2026-11-14, D-47): built on the page from the
 * worker's `q/dashboard` answer: each pack's state with its rule ceiling, the capacity meter's numbers
 * and the notices. Rule numbers are catalog ceilings ("up to N"): they are frozen between full
 * releases and are the numbers the capacity check itself uses (filter-pipeline notes §8). Pure.
 */
import type { PackId } from '../ids.js';
import { GUARANTEED_STATIC_RULES } from '../limits.js';
import { isPackEnabled } from '../reconcile/packChoice.js';
import { own } from '../record.js';
import { hiddenSites } from '../userFilters/list.js';
import type { Dashboard, DashboardAnswer, PackRow } from './dashboardSchema.js';

export type { Dashboard, PackRow } from './dashboardSchema.js';

function ceilingOf(answer: DashboardAnswer, rulesets: readonly string[]): number {
  return rulesets.reduce((sum, id) => sum + (own(answer.ceilings, id) ?? 0), 0);
}

function packRow(answer: DashboardAnswer, pack: DashboardAnswer['packs'][number]): PackRow {
  return {
    id: pack.id,
    default: pack.default,
    enabled: isPackEnabled(answer.settings, pack.id as PackId, pack.default),
    toggleable: pack.toggleable,
    licence: pack.licence,
    ceiling: ceilingOf(answer, pack.rulesets),
    skipped: answer.skipped.find((s) => s.pack === pack.id)?.reason ?? null,
  };
}

/** The dashboard's view of a validated `q/dashboard` answer; packs in catalog order. */
export function describeDashboard(answer: DashboardAnswer): Dashboard {
  return {
    settings: answer.settings,
    packs: answer.packs.map((pack) => packRow(answer, pack)),
    capacity: { guaranteed: GUARANTEED_STATIC_RULES, usedCeiling: ceilingOf(answer, answer.enabledRulesets), available: answer.available },
    allSites: answer.allSites,
    popupGuard: answer.popupGuard,
    settingsReset: answer.settingsReset,
    lastRun: answer.lastRun,
    hidden: answer.userFilters === null ? null : hiddenSites({ v: 1, hosts: answer.userFilters }),
  };
}
