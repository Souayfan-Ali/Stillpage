/** A `q/dashboard` answer and a scripted request function for the dashboard's unit tests. */
import * as v from 'valibot';
import { vi } from 'vitest';
import { DashboardSchema, type Dashboard, type DashboardAnswer, type PackRow } from '../../../../src/core/messaging/dashboardSchema.js';
import { createDefaultSettings } from '../../../../src/core/state/defaults.js';
import type { PageResult, Request } from '../../../../src/features/dashboard/client.js';

const row = (id: string, enabled: boolean, extra: Partial<PackRow> = {}): PackRow => ({
  id,
  default: enabled,
  enabled,
  toggleable: id !== 'popups' && id !== 'gpc',
  licence: 'cleared',
  ceiling: 2000,
  skipped: null,
  ...extra,
});

export function dashboard(change: Partial<Dashboard> = {}): Dashboard {
  return v.parse(DashboardSchema, {
    settings: createDefaultSettings(),
    packs: [
      row('ads', true),
      row('trackers', true),
      row('malware', true),
      row('popups', true),
      row('cookies', false),
      row('annoy-overlays', false),
      row('params', false),
      row('gpc', false),
      row('reg-de', false),
      row('reg-zh', false, { licence: 'owner-pending' }),
    ],
    capacity: { guaranteed: 30_000, usedCeiling: 24_000, available: 280_000 },
    allSites: true,
    popupGuard: false,
    settingsReset: false,
    lastRun: 'ok',
    hidden: [],
    ...change,
  });
}

type Answer = PageResult<unknown>;

/** The worker answer that describes `d`: one ruleset per pack (its ceiling), one more for the meter. */
function answerOf(d: Dashboard): DashboardAnswer {
  const used = 'used-total';
  const enabled = (id: string): boolean | undefined => d.packs.find((p) => p.id === id)?.enabled;
  const choices = Object.fromEntries(d.packs.filter((p) => p.id !== 'cookies' && p.id !== 'gpc' && p.enabled !== p.default).map((p) => [p.id, p.enabled]));
  const settings = {
    ...d.settings,
    packs: { ...d.settings.packs, ...choices },
    cookieBanners: enabled('cookies') === true ? 'hide' : d.settings.cookieBanners,
    gpc: enabled('gpc') ?? d.settings.gpc,
  } as Dashboard['settings'];
  return {
    settings,
    packs: d.packs.map((p) => ({ id: p.id, default: p.default, toggleable: p.toggleable, licence: p.licence, rulesets: [p.id] })),
    ceilings: { ...Object.fromEntries(d.packs.map((p) => [p.id, p.ceiling])), [used]: d.capacity.usedCeiling },
    enabledRulesets: [used],
    available: d.capacity.available,
    skipped: d.packs.flatMap((p) => (p.skipped === null ? [] : [{ pack: p.id, reason: p.skipped }])),
    allSites: d.allSites,
    popupGuard: d.popupGuard,
    settingsReset: d.settingsReset,
    lastRun: d.lastRun,
    userFilters: d.hidden === null ? null : Object.fromEntries(d.hidden.map((s) => [s.host, s.selectors])),
  };
}

/** A request function answering `q/dashboard` with `state()` and commands with `answers[type]` (default ok). */
export function scripted(state: () => Dashboard | null, answers: Readonly<Record<string, Answer>> = {}) {
  return vi.fn((type: string, _payload: unknown, schema: v.GenericSchema): Promise<Answer> => {
    if (type === 'q/dashboard') {
      const data = state();
      return Promise.resolve(data === null ? { ok: false, error: { code: 'no-answer' } } : { ok: true, data: v.parse(schema, answerOf(data)) });
    }
    const answer = answers[type] ?? { ok: true, data: {} };
    return Promise.resolve(answer.ok ? { ok: true, data: v.parse(schema, answer.data) } : answer);
  }) as unknown as Request & ReturnType<typeof vi.fn>;
}
