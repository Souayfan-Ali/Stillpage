/**
 * The blocked page's decision table (P2-55, pop-up notes §6.2) as a pure function. Inputs come from
 * `tabs.getCurrent()` (`openerTabId`), `history.length` and the opener sentinel's answer to
 * `x/linkClickCheck` (P2-57; no answer within `LINK_CHECK_TIMEOUT_MS` counts as "no direct click").
 */

export interface Situation {
  readonly historyLength: number;
  readonly hasOpener: boolean;
  /**
   * The opener's sentinel confirms it let a script open a new context just now (`x/openedCheck`, design review,
   * P2-58). `openerTabId` alone is not proof: Chrome sets it for user-opened tabs too (Ctrl+T, bookmarks).
   */
  readonly openerReportsScriptOpen: boolean;
  /** The opener reports a direct click on a visible link to this host. */
  readonly openerReportsLinkClick: boolean;
}

export type BlockedDecision =
  /** A pop-up a page script opened: the tab closes itself (the opener's notice says so). */
  | { readonly kind: 'close' }
  /** `reason: 'link'` = "This link leads to a site known for pop-up ads". */
  | { readonly kind: 'stay'; readonly primary: 'go-back' | 'close-tab'; readonly reason: 'link' | 'listed' };

/** Closes only on a positive "opened by a page script" signal; every user-opened tab stays. */
export function decideBlockedPage(s: Situation): BlockedDecision {
  if (s.historyLength > 1) return { kind: 'stay', primary: 'go-back', reason: 'listed' };
  if (s.hasOpener && s.openerReportsScriptOpen && !s.openerReportsLinkClick) return { kind: 'close' };
  return { kind: 'stay', primary: 'close-tab', reason: s.hasOpener && s.openerReportsLinkClick ? 'link' : 'listed' };
}
