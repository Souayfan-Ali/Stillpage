/**
 * What the reconciler needs for pop-up protection (P2-54): the two packaged host lists, read from our
 * own package on every run and checked as a boundary, and the wiring of parts other tasks ship. A list
 * that cannot be read or parsed is logged and treated as empty: the static `popups` ruleset still blocks
 * every listed destination (pop-up notes §6.1), only the redirect, the list Strict sites or the lift
 * (`popup-lifted.json`, D-55a: those hosts then keep the ordinary redirect at 2) are missing.
 */
import { parseHostList, parseLiftedList } from '../core/reconcile/popupLists.js';
import type { PopupInputs } from '../core/reconcile/popups.js';
import { POPUP_LIST_STRICT_DEFAULT } from '../core/state/defaults.js';
import type { Ports } from '../platform/ports.js';

/**
 * Wiring switches (design review, 2026-11-14): `blocked.html` arrives with P2-55, the guard scripts with
 * P2-57 / P2-58. Until each flips, listed hosts keep Chrome's plain block and no guard is registered,
 * so a build never redirects to, or registers, a file it does not ship.
 */
const SHIPPED: { readonly blockedPage: boolean; readonly guardScripts: boolean } = { blockedPage: true, guardScripts: true };
const BLOCKED_PAGE = 'blocked.html';

/** True once the guard scripts ship (P2-57/58); the dashboard says so beside the pop-up controls (P2-60). */
export function isGuardShipped(): boolean {
  return SHIPPED.guardScripts;
}

/** The ports the inputs need (an E2E helper passes its own, reading the package through a page). */
type ListPorts = Pick<Ports, 'package' | 'log'>;

async function readFile<T>(ports: ListPorts, file: string, parse: (text: string) => T | null, empty: T): Promise<T> {
  let cause: unknown = 'not a valid list';
  try {
    const value = parse(await ports.package.readText(file));
    if (value !== null) return value;
  } catch (error) {
    // Reported below with the parse failure: one message per list, with its cause.
    cause = error;
  }
  ports.log.error(`pop-up list ${file} unusable`, cause);
  return empty;
}

export async function readPopupInputs(ports: ListPorts, runtimeId: string): Promise<PopupInputs> {
  const [destinations, strictSites, lifted] = await Promise.all([
    readFile(ports, 'popup-destinations.json', parseHostList, []),
    readFile(ports, 'popup-strict-sites.json', parseHostList, []),
    readFile(ports, 'popup-lifted.json', parseLiftedList, {}),
  ]);
  return {
    destinations,
    lifted,
    strictSites,
    blockedPageUrl: SHIPPED.blockedPage ? `chrome-extension://${runtimeId}/${BLOCKED_PAGE}` : null,
    guardShipped: SHIPPED.guardScripts,
    listStrict: POPUP_LIST_STRICT_DEFAULT,
  };
}
