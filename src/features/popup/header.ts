/**
 * Header state of the toolbar panel (P1-40, UI notes §3): one of the table's states, with its text,
 * icon, tone and actions, derived from the worker's `q/tabState` answer. Pure; the order of the checks
 * is the precedence of the states.
 */
import type { Level } from '../../core/state/types.js';
import type { IconName } from '../../ui/Icon.js';
import type { BannerTone } from '../../ui/Banner.js';
import { STRINGS } from './strings.js';
import type { TabState } from '../../core/messaging/tabState.js';

export type HeaderKind = 'normal' | 'off' | 'paused' | 'reduced' | 'limited' | 'restricted' | 'admin' | 'setup' | 'reset';
export type HeaderAction = 'turnOn' | 'resume' | 'allowSite' | 'allowAll' | 'restore' | 'dismiss';

export interface Header {
  readonly kind: HeaderKind;
  readonly text: string;
  readonly icon: IconName;
  /** `ok` is the plain protected line; every other tone is drawn as a banner. */
  readonly tone: BannerTone | 'ok';
  readonly actions: readonly HeaderAction[];
  /** Whether the level selector is offered in this state. */
  readonly showsLevels: boolean;
}

const MINUTE_MS = 60_000;

const make = (kind: HeaderKind, text: string, icon: IconName, tone: Header['tone'], actions: readonly HeaderAction[], showsLevels: boolean): Header => ({
  kind,
  text,
  icon,
  tone,
  actions,
  showsLevels,
});

function pausedText(until: number, now: number): string {
  return STRINGS.paused(Math.max(1, Math.ceil((until - now) / MINUTE_MS)));
}

/** States in which the page cannot be filtered or the panel cannot act yet. */
function blockingState(state: TabState): Header | null {
  if (state.page === 'restricted') return make('restricted', STRINGS.restricted, 'unavailable', 'neutral', [], false);
  if (state.page === 'admin') return make('admin', STRINGS.admin, 'unavailable', 'neutral', [], false);
  if (!state.ready) return make('setup', STRINGS.setup, 'pending', 'info', [], false);
  return null;
}

function levelState(state: TabState, now: number): Header | null {
  if (state.level !== 'off') return null;
  return state.pausedUntil === null
    ? make('off', STRINGS.off, 'off', 'neutral', ['turnOn'], false)
    : make('paused', pausedText(state.pausedUntil, now), 'paused', 'neutral', ['resume'], false);
}

function accessState(state: TabState, level: Level): Header {
  if (state.access === 'none') {
    const actions: readonly HeaderAction[] = state.host === null ? ['allowAll'] : ['allowSite', 'allowAll'];
    return make('reduced', STRINGS.reduced, 'reduced', 'warning', actions, true);
  }
  if (state.access === 'site') return make('limited', STRINGS.limited(level), 'on', 'info', ['allowAll'], true);
  return make('normal', STRINGS.protected(level), 'on', 'ok', [], true);
}

export function headerOf(state: TabState, now: number): Header {
  const blocking = blockingState(state);
  if (blocking !== null) return blocking;
  if (state.settingsReset) return make('reset', STRINGS.reset, 'warning', 'error', ['restore', 'dismiss'], true);
  return levelState(state, now) ?? accessState(state, state.level);
}
