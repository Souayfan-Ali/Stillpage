/**
 * Step 2's extras (P2-33, UI notes §7): the choices offered, which packs each one switches, the
 * suggested language pack (computed locally from the browser's UI language, P2-29) and the commands
 * that apply a set of choices. Pure.
 */
import type { PackId } from '../../core/ids.js';
import type { Dashboard } from '../../core/messaging/dashboard.js';
import { suggestRegionalPacks } from '../../core/reconcile/regional.js';

export const EXTRAS = ['cookies', 'annoyances', 'language', 'params', 'gpc'] as const;
export type ExtraId = (typeof EXTRAS)[number];
export type Choices = Readonly<Partial<Record<ExtraId, boolean>>>;

const ANNOYANCES = 'annoy-';

/** The packs behind each extra in this build; an extra with no pack is not offered. */
export function packsOf(data: Dashboard, language: string): Readonly<Record<ExtraId, readonly string[]>> {
  const ids = data.packs.map((p) => p.id);
  const has = (id: string): readonly string[] => (ids.includes(id) ? [id] : []);
  return {
    cookies: has('cookies'),
    annoyances: ids.filter((id) => id.startsWith(ANNOYANCES)),
    language: suggestRegionalPacks([language], ids as PackId[]).slice(0, 1),
    params: has('params'),
    gpc: has('gpc'),
  };
}

/** What the page shows first: each extra as it is now, with the suggested language pack pre-checked. */
export function initialChoices(data: Dashboard, language: string): Choices {
  const packs = packsOf(data, language);
  const on = (ids: readonly string[]): boolean => ids.length > 0 && ids.every((id) => data.packs.find((p) => p.id === id)?.enabled === true);
  return Object.fromEntries(
    EXTRAS.filter((extra) => packs[extra].length > 0).map((extra) => [extra, extra === 'language' ? true : on(packs[extra])]),
  );
}

export type Step2Command = { readonly extra: ExtraId; readonly type: 'c/setPack'; readonly pack: string; readonly enabled: boolean } | { readonly extra: 'gpc'; readonly type: 'c/setGpc'; readonly enabled: boolean };

/** The commands that turn the current state into `choices` (only the packs that change). */
export function commandsFor(data: Dashboard, language: string, choices: Choices): readonly Step2Command[] {
  const packs = packsOf(data, language);
  const enabled = (id: string): boolean => data.packs.find((p) => p.id === id)?.enabled === true;
  return EXTRAS.flatMap((extra): Step2Command[] => {
    const want = choices[extra];
    if (want === undefined) return [];
    if (extra === 'gpc') return enabled('gpc') === want ? [] : [{ extra, type: 'c/setGpc', enabled: want }];
    return packs[extra].filter((pack) => enabled(pack) !== want).map((pack) => ({ extra, type: 'c/setPack', pack, enabled: want }));
  });
}
