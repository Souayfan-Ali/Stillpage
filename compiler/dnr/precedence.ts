/**
 * Which of two matching rules Chrome applies (research notes 02 §1.5): the higher priority wins; on a tie
 * `allow` > `allowAllRequests` > `block` > `upgradeScheme` > `redirect`. `modifyHeaders` is resolved
 * separately (it applies when it outranks every matching allow) and is not ordered here.
 */
import type { DnrRule } from './schema.js';

const ACTION_ORDER = ['allow', 'allowAllRequests', 'block', 'upgradeScheme', 'redirect'] as const;
const DEFAULT_PRIORITY = 1;

const rank = (r: DnrRule): number => {
  const i = ACTION_ORDER.indexOf(r.action.type as (typeof ACTION_ORDER)[number]);
  if (i === -1) throw new Error(`no precedence for action "${r.action.type}"`);
  return i;
};

/** True when `a` wins over `b` for a request both match. */
export function outranks(a: DnrRule, b: DnrRule): boolean {
  const pa = a.priority ?? DEFAULT_PRIORITY;
  const pb = b.priority ?? DEFAULT_PRIORITY;
  return pa !== pb ? pa > pb : rank(a) < rank(b);
}
