/**
 * The preview's list of changes (P2-37): every visible difference between the settings now and the
 * settings a restore would store, in dashboard order. Computed by the page from the two settings the
 * worker answers (the worker bundle stays small); sites newly set to Off and sites newly allowed to
 * open pop-ups are counted apart and named (`weakened`, `weakenedHosts`: security review M1, P2-43). Pure.
 */
import type { Hostname, PackId } from '../ids.js';
import { isPackEnabled } from '../reconcile/packChoice.js';
import { own } from '../record.js';
import type { Settings } from './types.js';

/** What the page knows about each pack (from the `q/dashboard` rows). */
export interface PackInfo {
  readonly id: string;
  readonly default: boolean;
  readonly toggleable: boolean;
}

type DefaultLevel = Settings['defaultLevel'];
type Mode = Settings['popups']['mode'];

export type Change =
  | { readonly kind: 'defaultLevel'; readonly from: DefaultLevel; readonly to: DefaultLevel }
  | { readonly kind: 'pack'; readonly pack: string; readonly to: boolean }
  | ({ readonly kind: 'siteLevels' } & Counts)
  | { readonly kind: 'popupMode'; readonly from: Mode; readonly to: Mode }
  | ({ readonly kind: 'popupSites' } & Counts)
  | { readonly kind: 'popupNotice' | 'gpc' | 'badge'; readonly to: boolean }
  | { readonly kind: 'theme'; readonly to: Settings['ui']['theme'] }
  | { readonly kind: 'hidden'; readonly added: number; readonly removed: number };

interface Counts {
  added: number;
  removed: number;
  changed: number;
  weakened: number;
  /** The hosts newly weakened, sorted: the preview names them (P2-43 security review A-1). */
  weakenedHosts: readonly Hostname[];
}

function siteCounts<V>(before: Readonly<Record<Hostname, V>>, after: Readonly<Record<Hostname, V>>, weakest: V): Counts {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)] as Hostname[])].sort();
  const counts = { added: 0, removed: 0, changed: 0 };
  const weakenedHosts: Hostname[] = [];
  for (const host of keys) {
    const [a, b] = [own(before, host), own(after, host)];
    if (b === weakest && a !== weakest) weakenedHosts.push(host);
    if (a === undefined) counts.added += 1;
    else if (b === undefined) counts.removed += 1;
    else if (a !== b) counts.changed += 1;
  }
  return { ...counts, weakened: weakenedHosts.length, weakenedHosts };
}

const anySites = (c: Counts): boolean => c.added + c.removed + c.changed > 0;

function packChanges(before: Settings, after: Settings, packs: readonly PackInfo[]): Change[] {
  return packs.flatMap((pack): Change[] => {
    const [was, will] = [isPackEnabled(before, pack.id as PackId, pack.default), isPackEnabled(after, pack.id as PackId, pack.default)];
    return pack.toggleable && was !== will ? [{ kind: 'pack', pack: pack.id, to: will }] : [];
  });
}

/** Every visible difference between `before` and `after`, in dashboard order. */
export function changesOf(before: Settings, after: Settings, packs: readonly PackInfo[]): Change[] {
  const levels = siteCounts(before.siteLevels, after.siteLevels, 'off');
  const popupSites = siteCounts(before.popups.sites, after.popups.sites, 'allow');
  const changes: (Change | null)[] = [
    before.defaultLevel === after.defaultLevel ? null : { kind: 'defaultLevel', from: before.defaultLevel, to: after.defaultLevel },
    ...packChanges(before, after, packs),
    anySites(levels) ? { kind: 'siteLevels', ...levels } : null,
    before.popups.mode === after.popups.mode ? null : { kind: 'popupMode', from: before.popups.mode, to: after.popups.mode },
    anySites(popupSites) ? { kind: 'popupSites', ...popupSites } : null,
    before.popups.notice === after.popups.notice ? null : { kind: 'popupNotice', to: after.popups.notice },
    before.gpc === after.gpc ? null : { kind: 'gpc', to: after.gpc },
    before.ui.showBadge === after.ui.showBadge ? null : { kind: 'badge', to: after.ui.showBadge },
    before.ui.theme === after.ui.theme ? null : { kind: 'theme', to: after.ui.theme },
  ];
  return changes.filter((c): c is Change => c !== null);
}

type FilterHosts = Readonly<Record<string, readonly string[]>>;

const pairs = (hosts: FilterHosts): ReadonlySet<string> => new Set(Object.entries(hosts).flatMap(([host, list]) => list.map((s) => JSON.stringify([host, s]))));

/** Hidden items (P2-22) a restore adds and removes, one per host and selector; `null` when the same. */
export function hiddenChange(before: FilterHosts, after: FilterHosts): Change | null {
  const [was, will] = [pairs(before), pairs(after)];
  const added = [...will].filter((p) => !was.has(p)).length;
  const removed = [...was].filter((p) => !will.has(p)).length;
  return added + removed === 0 ? null : { kind: 'hidden', added, removed };
}
