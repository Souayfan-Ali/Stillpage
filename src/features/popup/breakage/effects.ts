/**
 * Carrying out the breakage flow's effects from the toolbar panel (P2-14; design review: the panel runs the
 * pure machine, the worker stays the only settings writer). A settings change becomes the matching
 * site command; each answers with the host's values as stored, which the flow uses for its
 * compare-and-revert instead of a second read.
 */
import { LADDERS, remedyAvailability } from '../../../core/breakage/ladders.js';
import type { Availability, Change, Effect, Remedy } from '../../../core/breakage/types.js';
import type { Hostname } from '../../../core/ids.js';
import type { TabState } from '../../../core/messaging/tabState.js';
import type { SiteSnapshot } from '../../../core/state/site.js';
import type { Client, ClientResult } from '../client.js';
import { FLOW_STRINGS } from './strings.js';

/** The machine's minutes for a pause trial (UI notes §6: "Pause 30 minutes"). */
const PAUSE_MINUTES = 30;

const EMPTY_SITE: SiteSnapshot = { ownLevel: null, popupPolicy: null, pausedUntil: null };

/** The host's own values from a tab state (none stored → all `null`). */
export const siteOf = (state: TabState): SiteSnapshot => state.site ?? EMPTY_SITE;

/** Whether each remedy of every ladder would change anything here (unavailable rungs are skipped). */
export function availabilityOf(state: TabState, host: Hostname): Readonly<Partial<Record<Remedy, Availability>>> {
  const ctx = {
    host,
    level: { level: state.level, setOn: state.setOn as Hostname | null, pausedUntil: state.pausedUntil },
    siteAccess: state.access !== 'none',
    popupPolicy: siteOf(state).popupPolicy,
    guardShipped: state.popupGuard,
  };
  const remedies = [...new Set(Object.values(LADDERS).flat(2))];
  return Object.fromEntries(remedies.map((r) => [r, remedyAvailability(r, ctx)]));
}

/** Applies one change through the worker. A pause back to "none" is "Resume now" (`inherit`), which keeps a chosen level. */
function applyChange(client: Pick<Client, 'siteCommand'>, change: Change): Promise<ClientResult<SiteSnapshot>> {
  const hostname = change.host;
  switch (change.kind) {
    case 'siteLevel':
      return client.siteCommand('c/setSiteLevel', { hostname, level: change.level });
    case 'popupPolicy':
      return client.siteCommand('c/setSitePopupPolicy', { hostname, policy: change.policy ?? 'inherit' });
    case 'pause':
      return change.until === null
        ? client.siteCommand('c/setSiteLevel', { hostname, level: 'inherit' })
        : client.siteCommand('c/pauseSite', { hostname, minutes: PAUSE_MINUTES });
  }
}

/** What running effects did: `ok` false when a settings change was refused; `site` is the last stored value. */
export interface RunResult {
  readonly ok: boolean;
  readonly site: SiteSnapshot | null;
}

interface RunDeps {
  readonly client: Pick<Client, 'siteCommand' | 'command'>;
  readonly reloadTab: (tabId: number) => Promise<void>;
  readonly tabId: number;
}

async function pickerText(deps: RunDeps): Promise<string> {
  const picker = await deps.client.command('c/startPicker', { tabId: deps.tabId, mode: 'hide' });
  if (picker.ok) return FLOW_STRINGS.pickerStarted;
  return picker.error.code === 'not-implemented' ? FLOW_STRINGS.pickerMissing : FLOW_STRINGS.pickerFailed;
}

/** Runs effects in order; stops at the first refused settings change and says so through `say`. */
export async function runEffects(deps: RunDeps, effects: readonly Effect[], say: (text: string) => void): Promise<RunResult> {
  let site: SiteSnapshot | null = null;
  for (const effect of effects) {
    if (effect.type === 'apply') {
      const result = await applyChange(deps.client, effect.change);
      if (!result.ok) {
        say(FLOW_STRINGS.applyFailed);
        return { ok: false, site };
      }
      site = result.data;
    } else if (effect.type === 'reload') {
      await deps.reloadTab(deps.tabId).catch(() => {
        say(FLOW_STRINGS.reloadFailed);
      });
    } else if (effect.type === 'openPicker') {
      say(await pickerText(deps));
    }
  }
  return { ok: true, site };
}
